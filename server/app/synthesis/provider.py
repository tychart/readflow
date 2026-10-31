from __future__ import annotations

import asyncio
import gc
import io
import logging
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from time import perf_counter
from typing import Any, Protocol

from app.jobs.models import ChunkRecord
from app.telemetry.memory import MIB, MemoryStats, system_memory_stats
from app.voices.registry import VoicePrompt

logger = logging.getLogger(__name__)

# Qwen3-TTS streams a 12 Hz codec, so one second of audio is 12 codec tokens.
CODEC_TOKENS_PER_SECOND = 12
# Floor for the per-batch generation budget. Estimates are character-based, so a
# very short chunk still gets room for a full sentence.
MIN_SYNTHESIS_TOKENS = 600
# The model's own default cap (2048 tokens ≈ 170s of audio). Used as the upper
# bound when a retry needs more room than the first estimate allowed.
MAX_SYNTHESIS_TOKENS = 2048


class SynthesisOOMError(RuntimeError):
    pass


class SynthesisTimeoutError(RuntimeError):
    """Raised when a model load or synthesis call exceeds its deadline.

    A timed-out call leaves the single worker thread running (a thread stuck in
    native code cannot be interrupted), so the model manager moves to
    `ModelState.ERROR` and the scheduler stops dispatching until the provider is
    reset. See `ModelManager.reset_provider`.
    """

    pass


class ModelVRAMError(RuntimeError):
    """Raised when there is insufficient VRAM to load the model."""

    pass


@dataclass(slots=True)
class RawSynthesisResult:
    wav_bytes: bytes
    reserved_vram_mb: int
    allocated_vram_mb: int
    # True when generation stopped at the token budget instead of emitting EOS.
    # The audio is probably clipped (or the sample degenerated), so the worker
    # surfaces it instead of silently shipping it.
    truncated: bool = False


class SynthesisProvider(Protocol):
    def validate_environment(self) -> None: ...
    def set_device(self, device: str) -> None: ...
    def reset(self) -> None: ...
    async def load_model(self, model_id: str) -> None: ...
    async def unload_model(self) -> None: ...
    async def synthesize_batch(
        self, model_id: str, chunks: list[ChunkRecord], prompts: list[VoicePrompt]
    ) -> list[RawSynthesisResult]: ...
    async def memory_stats(self) -> MemoryStats: ...


class FakeQwenProvider:
    def __init__(self) -> None:
        self._loaded = False
        self._device: str = "auto"

    def validate_environment(self) -> None:
        return None

    def set_device(self, device: str) -> None:
        self._device = device

    def reset(self) -> None:
        self._loaded = False
        self._device = "auto"

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

    async def memory_stats(self) -> MemoryStats:
        # Synthesis is simulated, but never invent host resource measurements.
        return await asyncio.to_thread(system_memory_stats)

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
        estimated_chars_per_second: float = 18.0,
        synthesis_token_headroom: float = 1.4,
    ) -> None:
        self._default_language = default_language
        self._device = device
        self._estimated_chars_per_second = estimated_chars_per_second
        self._synthesis_token_headroom = synthesis_token_headroom
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

    def set_device(self, device: str) -> None:
        self._device = device

    def reset(self) -> None:
        """Replace the worker executor and drop all model state.

        This is the recovery path for a stuck provider thread: the old pool is
        shut down without waiting (a thread blocked in native code cannot be
        interrupted, so it is abandoned deliberately) and a fresh single-worker
        pool takes over, letting the scheduler recover without a server
        restart. `cancel_futures=True` discards work that piled up behind the
        stuck call instead of replaying it.
        """
        old_executor = self._executor
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="readflow-qwen")
        old_executor.shutdown(wait=False, cancel_futures=True)
        self._model = None
        self._loaded_model_id = None
        self._prompt_cache.clear()

    def validate_environment(self) -> None:
        torch, _qwen_model_class = _import_qwen_runtime()
        if self._device == "gpu" and not torch.cuda.is_available():
            raise RuntimeError(
                "READFLOW_TTS_PROVIDER is set to 'qwen' with device='gpu', "
                "but CUDA is not available. Set device='auto' or 'cpu' instead."
            )
        if self._device == "cpu":
            return  # CPU is always available if torch is installed

    def _resolve_device(self) -> str:
        """Resolve the device string based on the configured device mode.

        "auto" — use CUDA when available, fall back to CPU.
        "gpu" — require CUDA. If CUDA is unavailable, raise at load time.
        "cpu" — force CPU regardless of GPU availability.
        """
        torch, _qwen_model_class = _import_qwen_runtime()
        if self._device == "cpu":
            return "cpu"
        if self._device == "gpu":
            if torch.cuda.is_available():
                return "cuda:0"
            return "cpu"  # cpu placeholder; actual error raised at load
        # auto — prefer GPU if there's enough VRAM, fall back to CPU
        if torch.cuda.is_available():
            free, _total = torch.cuda.mem_get_info(0)
            free_mb = free / MIB
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

    async def memory_stats(self) -> MemoryStats:
        # Read-only CUDA allocator/device queries are thread-safe. Do not queue
        # monitoring behind synthesis: it must remain live during a long batch.
        return await asyncio.to_thread(self._memory_stats_sync)

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

        # "gpu" mode: fail hard if CUDA is not available — don't silently fall back
        if self._device == "gpu" and not torch.cuda.is_available():
            raise ModelVRAMError(
                "Device is set to 'gpu', but CUDA is not available on this system. "
                "Choose 'auto' or 'cpu' instead."
            )

        try:
            _do_load(device)
            self._resolved_device = device
        except RuntimeError as exc:
            is_oom = "out of memory" in str(exc).lower()

            # "gpu" mode: OOM at load time means not enough VRAM
            if self._device == "gpu" and is_oom:
                self._clear_cuda_after_failure_sync()
                raise ModelVRAMError(
                    f"Not enough VRAM to load '{model_id}' on GPU. "
                    "Choose 'auto' (GPU with CPU fallback) or 'cpu' instead."
                ) from exc

            # "auto" mode: standard fallback
            if self._device == "auto" and is_oom:
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
        max_new_tokens = self._generation_budget(chunks)
        started = perf_counter()
        wavs, sample_rate = model.generate_voice_clone(
            text=text_batch,
            language=language or self._default_language,
            voice_clone_prompt=prompt_batch,
            max_new_tokens=max_new_tokens,
        )
        generate_seconds = perf_counter() - started
        truncated = self._truncated_indices(wavs, sample_rate, max_new_tokens)
        if truncated:
            # Batched generation runs until the *slowest* sequence stops, so a
            # sample that never emits EOS used to hold the whole batch for the
            # model's full default budget. Now it is cut off here and only that
            # chunk is asked again on its own.
            logger.warning(
                "Generation hit the %d-token budget for chunk(s) %s (batch of %d); "
                "regenerating those alone",
                max_new_tokens,
                [chunks[index].index for index in truncated],
                len(chunks),
            )
            wavs, truncated = self._regenerate_truncated(
                model=model,
                chunks=chunks,
                prompt_batch=prompt_batch,
                language=language or self._default_language,
                wavs=wavs,
                truncated=truncated,
                max_new_tokens=max_new_tokens,
            )
        audio_seconds = sum(len(wav) / sample_rate for wav in wavs) if sample_rate else 0.0
        logger.info(
            "Batch of %d chunk(s): %.1fs audio in %.1fs generation (budget %d tokens)",
            len(chunks),
            audio_seconds,
            generate_seconds,
            max_new_tokens,
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
                truncated=index in truncated,
            )
            for index, wav in enumerate(wavs)
        ]

    def _generation_budget(self, chunks: list[ChunkRecord]) -> int:
        """Upper bound on the codec tokens one batch may generate.

        Qwen's default is 2048 tokens ≈ 170s of audio *per sequence*, and a
        batched call only returns when every sequence stops. A single sample
        that fails to emit EOS therefore burned minutes of GPU time — and the
        growing KV cache is also what made a large batch run out of VRAM. Budget
        the longest chunk's expected duration plus headroom instead.
        """
        longest_chars = max(len(chunk.text) for chunk in chunks)
        expected_seconds = max(0.5, longest_chars / self._estimated_chars_per_second)
        budget = int(expected_seconds * CODEC_TOKENS_PER_SECOND * self._synthesis_token_headroom)
        return max(MIN_SYNTHESIS_TOKENS, budget)

    @staticmethod
    def _truncated_indices(wavs: Any, sample_rate: int, max_new_tokens: int) -> set[int]:
        """Indices whose waveform ran into the token budget (no EOS emitted)."""
        if not sample_rate:
            return set()
        limit = max_new_tokens - 2
        return {
            index
            for index, wav in enumerate(wavs)
            if round(len(wav) / sample_rate * CODEC_TOKENS_PER_SECOND) >= limit
        }

    def _regenerate_truncated(
        self,
        *,
        model: Any,
        chunks: list[ChunkRecord],
        prompt_batch: Any,
        language: str,
        wavs: Any,
        truncated: set[int],
        max_new_tokens: int,
    ) -> tuple[list[Any], set[int]]:
        """Re-ask for the chunks that hit the budget, one at a time.

        A fresh sample almost always terminates normally, and generating a single
        chunk is cheap next to repeating the whole batch. The retry gets double
        the budget (capped at the model default) so a chunk whose duration was
        genuinely underestimated is not clipped a second time. Whatever still
        runs into the budget is reported through `RawSynthesisResult.truncated`.
        """
        retry_budget = min(MAX_SYNTHESIS_TOKENS, max_new_tokens * 2)
        repaired = list(wavs)
        still_truncated: set[int] = set()
        for index in sorted(truncated):
            retry_wavs, retry_rate = model.generate_voice_clone(
                text=[chunks[index].text],
                language=language,
                voice_clone_prompt=self._repeat_voice_clone_prompt(prompt_batch[index], 1),
                max_new_tokens=retry_budget,
            )
            retried = self._truncated_indices(retry_wavs, retry_rate, retry_budget)
            if retry_wavs and 0 not in retried:
                repaired[index] = retry_wavs[0]
            else:
                still_truncated.add(index)
        return repaired, still_truncated

    def _get_or_create_voice_clone_prompt(self, prompt: VoicePrompt) -> Any:
        if prompt.voice_id not in self._prompt_cache:
            model = self._require_model()
            self._prompt_cache[prompt.voice_id] = model.create_voice_clone_prompt(
                ref_audio=prompt.reference_audio_path,
                ref_text=prompt.reference_text,
                x_vector_only_mode=False,
            )
        return self._prompt_cache[prompt.voice_id]

    def _memory_stats_sync(self) -> MemoryStats:
        gpu: dict[str, int] = {}
        try:
            # Monitoring needs torch only, not the Qwen model or its worker.
            import torch

            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info(0)
                # CUDA reports usable capacity, excluding memory reserved by
                # the driver/firmware (so this can be below the marketed size).
                gpu = {
                    "vram_total_mb": total // MIB,
                    "vram_free_mb": free // MIB,
                    "vram_used_mb": total // MIB - free // MIB,
                    "vram_allocated_mb": _mb_from_bytes(torch.cuda.memory_allocated(0)),
                    "vram_reserved_mb": _mb_from_bytes(torch.cuda.memory_reserved(0)),
                }
        except Exception:
            # A GPU/driver failure must not hide otherwise valid RAM readings.
            # Null means unavailable, not zero usage or an entirely free GPU.
            logger.warning("GPU memory statistics unavailable", exc_info=True)
        # Sample RAM after importing/querying torch: the first reading must
        # include the RAM consumed by importing the runtime and CUDA context.
        return system_memory_stats(device=self._resolved_device).model_copy(update=gpu)

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
