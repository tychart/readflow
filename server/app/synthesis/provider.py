from __future__ import annotations

import asyncio
import gc
import io
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from typing import Any, Protocol

from app.jobs.models import ChunkRecord
from app.voices.registry import VoicePrompt


class SynthesisOOMError(RuntimeError):
    pass


@dataclass(slots=True)
class RawSynthesisResult:
    wav_bytes: bytes
    reserved_vram_mb: int
    allocated_vram_mb: int


class SynthesisProvider(Protocol):
    def validate_environment(self) -> None: ...
    async def load_model(self, model_id: str) -> None: ...
    async def unload_model(self) -> None: ...
    async def synthesize_batch(
        self, model_id: str, chunks: list[ChunkRecord], prompts: list[VoicePrompt]
    ) -> list[RawSynthesisResult]: ...
    async def memory_stats(self) -> tuple[bool, int, int, int, int, int, int, int, str]: ...


class FakeQwenProvider:
    def __init__(self) -> None:
        self._loaded = False

    def validate_environment(self) -> None:
        return None

    async def load_model(self, model_id: str) -> None:
        await asyncio.sleep(0.01)
        self._loaded = True

    async def unload_model(self) -> None:
        await asyncio.sleep(0)
        self._loaded = False

    async def synthesize_batch(
        self, model_id: str, chunks: list[ChunkRecord], prompts: list[VoicePrompt]
    ) -> list[RawSynthesisResult]:
        if not self._loaded:
            raise RuntimeError("Model is not loaded")
        del model_id, prompts
        batch_size = len(chunks)
        total_chars = sum(len(chunk.text) for chunk in chunks)
        if batch_size > 6 or total_chars > 2400:
            raise SynthesisOOMError("Synthetic OOM triggered for oversized batch")
        await asyncio.sleep(0.01 * batch_size)
        reserved = 2600 + batch_size * 250 + total_chars // 12
        allocated = int(reserved * 0.84)
        return [
            RawSynthesisResult(
                wav_bytes=self._build_wave_bytes(chunk.index, chunk.text),
                reserved_vram_mb=reserved,
                allocated_vram_mb=allocated,
            )
            for chunk in chunks
        ]

    async def memory_stats(self) -> tuple[bool, int, int, int, int, int, int, int, str]:
        return (True, 3100, 2500, 2800, 600, 16384, 10240, 4096, "cuda")

    def _build_wave_bytes(self, seed: int, text: str) -> bytes:
        import math
        import struct

        sample_rate = 22050
        seconds = max(1.0, min(12.0, len(text) / 22.0))
        total_frames = int(sample_rate * seconds)
        frequency = 220.0 + (seed % 5) * 35.0
        amplitude = 12000
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            for frame in range(total_frames):
                sample = int(amplitude * math.sin(2 * math.pi * frequency * (frame / sample_rate)))
                wav_file.writeframes(struct.pack("<h", sample))
        return buffer.getvalue()


class QwenProvider:
    def __init__(
        self,
        default_language: str = "English",
        device: str = "auto",
    ) -> None:
        self._default_language = default_language
        self._device = device
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="readflow-qwen")
        self._model: Any | None = None
        self._loaded_model_id: str | None = None
        self._prompt_cache: dict[str, Any] = {}
        self._attn_implementation: str | None = None  # resolved once at load time
        self._resolved_device: str = "cpu"  # tracks actual device used at load time

    def _resolve_attn_implementation(self) -> str:
        """Decide which attention implementation to use.

        FlashAttention 2 gives the best throughput but is optional —
        when it is absent (development machines, CI, or non-GPU builds)
        the provider falls back to PyTorch's SDPA path so the app still
        works end-to-end with the fake provider or a CPU-only install.
        """
        if self._attn_implementation is not None:
            return self._attn_implementation
        try:
            import flash_attn  # noqa: F401

            self._attn_implementation = "flash_attention_2"
        except ImportError:
            self._attn_implementation = "sdpa"
        return self._attn_implementation

    def validate_environment(self) -> None:
        torch, _qwen_model_class = _import_qwen_runtime()
        if self._device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError(
                "READFLOW_TTS_PROVIDER is set to 'qwen' with device='cuda', "
                "but CUDA is not available. Set device='auto' or 'cpu' instead."
            )
        if self._device == "cpu":
            return  # CPU is always available if torch is installed

    def _resolve_device(self) -> str:
        """Resolve the device string based on the configured device mode.

        "auto" — use CUDA when available, fall back to CPU.
        "cuda" — require CUDA (caller already validated in validate_environment).
        "cpu" — force CPU regardless of GPU availability.
        """
        torch, _qwen_model_class = _import_qwen_runtime()
        if self._device == "cpu":
            return "cpu"
        if self._device == "cuda":
            if torch.cuda.is_available():
                return "cuda:0"
            return "cpu"
        # auto — prefer GPU if there's enough VRAM, fall back to CPU
        if torch.cuda.is_available():
            total = torch.cuda.get_device_properties(0).total_memory
            used = torch.cuda.memory_allocated(0)
            free_mb = (total - used) / (1024 * 1024)
            if free_mb >= 2048:  # at least 2 GB free is required
                return "cuda:0"
        return "cpu"

    async def load_model(self, model_id: str) -> None:
        if self._loaded_model_id == model_id and self._model is not None:
            return
        await self._call_in_worker(self._load_model_sync, model_id)

    async def unload_model(self) -> None:
        await self._call_in_worker(self._unload_model_sync)

    async def synthesize_batch(
        self, model_id: str, chunks: list[ChunkRecord], prompts: list[VoicePrompt]
    ) -> list[RawSynthesisResult]:
        if self._loaded_model_id != model_id or self._model is None:
            raise RuntimeError(f"Model '{model_id}' is not loaded")
        if len(chunks) != len(prompts):
            raise RuntimeError(
                "Expected one voice prompt per chunk, "
                f"received {len(prompts)} prompts for {len(chunks)} chunks"
            )
        languages = {chunk.language for chunk in chunks}
        if not languages:
            return []
        if len(languages) != 1:
            raise RuntimeError("Mixed languages in one synthesis batch are not supported")
        voice_ids = {chunk.voice_id for chunk in chunks}
        if len(voice_ids) != 1:
            raise RuntimeError("Mixed voices in one synthesis batch are not supported")
        language = next(iter(languages))
        try:
            return await self._call_in_worker(
                self._synthesize_batch_sync,
                chunks,
                prompts,
                language,
            )
        except RuntimeError as exc:
            if _is_cuda_oom_error(exc):
                await self._call_in_worker(self._clear_cuda_after_failure_sync)
                raise SynthesisOOMError(str(exc)) from exc
            raise

    @property
    def attn_implementation(self) -> str:
        """Return the attention implementation this provider is using."""
        return self._resolve_attn_implementation()

    async def memory_stats(self) -> tuple[bool, int, int, int, int, int, int, int, str]:
        return await self._call_in_worker(self._memory_stats_sync)

    async def _call_in_worker(self, callback, *args):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, partial(callback, *args))

    def _load_model_sync(self, model_id: str) -> None:
        torch, qwen_model_class = _import_qwen_runtime()
        if self._loaded_model_id == model_id and self._model is not None:
            return
        if self._model is not None:
            self._unload_model_sync()

        def _do_load(device: str) -> None:
            self._model = qwen_model_class.from_pretrained(
                model_id,
                device_map=device,
                dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32,
                attn_implementation=self._resolve_attn_implementation(),
            )
            self._loaded_model_id = model_id
            self._prompt_cache = {}

        device = self._resolve_device()
        try:
            _do_load(device)
            self._resolved_device = device
        except RuntimeError as exc:
            # Safety net: if "auto" picked CUDA but VRAM was insufficient
            # at load time, fall back to CPU.
            if self._device == "auto" and "out of memory" in str(exc).lower():
                device = "cpu"
                _do_load(device)
                self._resolved_device = device
                return
            raise

    def _unload_model_sync(self) -> None:
        torch, _qwen_model_class = _import_qwen_runtime()
        self._prompt_cache.clear()
        self._model = None
        self._loaded_model_id = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def _synthesize_batch_sync(
        self,
        chunks: list[ChunkRecord],
        prompts: list[VoicePrompt],
        language: str,
    ) -> list[RawSynthesisResult]:
        torch, _qwen_model_class = _import_qwen_runtime()
        model = self._require_model()
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
        text_batch = [chunk.text for chunk in chunks]
        if not prompts:
            raise RuntimeError("At least one voice prompt is required for synthesis")
        first_voice_id = prompts[0].voice_id
        if any(prompt.voice_id != first_voice_id for prompt in prompts):
            raise RuntimeError("Mixed voices in one synthesis batch are not supported")
        base_prompt = self._get_or_create_voice_clone_prompt(prompts[0])
        prompt_batch = self._repeat_voice_clone_prompt(base_prompt, len(text_batch))
        wavs, sample_rate = model.generate_voice_clone(
            text=text_batch,
            language=language or self._default_language,
            voice_clone_prompt=prompt_batch,
        )
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            allocated = _mb_from_bytes(torch.cuda.max_memory_allocated())
            reserved = _mb_from_bytes(torch.cuda.max_memory_reserved())
        else:
            allocated = 0
            reserved = 0
        if len(wavs) != len(chunks):
            raise RuntimeError(
                f"Expected {len(chunks)} waveforms from Qwen, but received {len(wavs)}"
            )
        return [
            RawSynthesisResult(
                wav_bytes=self._waveform_to_wav_bytes(wav, sample_rate),
                reserved_vram_mb=reserved,
                allocated_vram_mb=allocated,
            )
            for wav in wavs
        ]

    def _get_or_create_voice_clone_prompt(self, prompt: VoicePrompt) -> Any:
        if prompt.voice_id not in self._prompt_cache:
            model = self._require_model()
            self._prompt_cache[prompt.voice_id] = model.create_voice_clone_prompt(
                ref_audio=prompt.reference_audio_path,
                ref_text=prompt.reference_text,
                x_vector_only_mode=False,
            )
        return self._prompt_cache[prompt.voice_id]

    def _memory_stats_sync(self) -> tuple[bool, int, int, int, int, int, int, int, str]:
        import psutil

        torch, _qwen_model_class = _import_qwen_runtime()

        # System RAM stats (always available)
        sys_mem = psutil.virtual_memory()
        ram_total = sys_mem.total // (1024 * 1024)
        ram_free = sys_mem.available // (1024 * 1024)

        # Process memory usage
        proc = psutil.Process()
        ram_used = _mb_from_bytes(proc.memory_info().rss)

        # VRAM stats — report only when the model is actually running on CUDA.
        # _resolved_device tracks the actual device used at load time so we
        # don't misreport VRAM when "auto" picked CPU.
        #
        # We use torch.cuda.memory_reserved() (not memory_allocated()) for
        # the primary VRAM metric because it matches what external tools
        # (nvidia-smi, nvtop, etc.) report.  PyTorch's caching allocator
        # keeps a large reserve of GPU memory that is not yet actively
        # allocated but is reserved and unavailable to other processes.
        #
        # memory_allocated  = currently active tensors in VRAM (smaller)
        # memory_reserved   = total reserved by the caching allocator (matches nvtop)
        is_cuda = self._resolved_device.startswith("cuda")
        if is_cuda and torch.cuda.is_available():
            vram_allocated = _mb_from_bytes(torch.cuda.memory_allocated(0))
            vram_reserved = _mb_from_bytes(torch.cuda.memory_reserved(0))
            vram_total = torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)
            vram_free = vram_total - vram_reserved
            return (
                is_cuda, vram_total, vram_allocated, vram_reserved, vram_free,
                ram_total, ram_free, ram_used, self._resolved_device,
            )

        # No CUDA or model not on GPU
        return (False, 0, 0, 0, 0, ram_total, ram_free, ram_used, self._resolved_device)

    def _clear_cuda_after_failure_sync(self) -> None:
        torch, _qwen_model_class = _import_qwen_runtime()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def _repeat_voice_clone_prompt(self, base_prompt: Any, batch_size: int) -> Any:
        if batch_size <= 0:
            raise RuntimeError("Batch size must be greater than zero")
        if isinstance(base_prompt, list):
            return base_prompt * batch_size
        if isinstance(base_prompt, tuple):
            return list(base_prompt) * batch_size
        return [base_prompt] * batch_size

    def _waveform_to_wav_bytes(self, waveform: Any, sample_rate: int) -> bytes:
        torch, _qwen_model_class = _import_qwen_runtime()
        if torch.is_tensor(waveform):
            tensor = waveform.detach().cpu()
        else:
            tensor = torch.as_tensor(waveform)
        if tensor.ndim > 1:
            tensor = tensor.squeeze()
        if tensor.ndim != 1:
            raise RuntimeError(f"Expected a mono waveform, got shape {tuple(tensor.shape)}")
        if torch.is_floating_point(tensor):
            pcm_tensor = (tensor.float().clamp(-1.0, 1.0) * 32767.0).to(torch.int16)
        else:
            pcm_tensor = tensor.to(torch.int16)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm_tensor.numpy().tobytes())
        return buffer.getvalue()

    def _require_model(self) -> Any:
        if self._model is None:
            raise RuntimeError("Qwen model is not loaded")
        return self._model


def _import_qwen_runtime():
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError as exc:
        raise RuntimeError(
            "Qwen runtime dependencies are not installed. Run `uv sync` in server/ "
            "with the pinned qwen-tts and flash-attn dependencies."
        ) from exc
    return torch, Qwen3TTSModel


def _mb_from_bytes(byte_count: int) -> int:
    return int(byte_count / (1024 * 1024))


def _is_cuda_oom_error(exc: RuntimeError) -> bool:
    return "out of memory" in str(exc).lower()
