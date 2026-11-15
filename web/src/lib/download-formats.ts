import type { DownloadFormatName } from "../types/api";

export interface DownloadFormatOption {
  value: DownloadFormatName;
  label: string;
  hint: string;
}

/**
 * The download menu, in the order the server offers the formats.
 *
 * These are labels, not encoding settings: `server/app/media/download_formats.py`
 * is the only place that decides codec, bitrate and container. Keep the two
 * lists in the same order so the menu does not shuffle between releases.
 */
export const DOWNLOAD_FORMAT_OPTIONS: readonly DownloadFormatOption[] = [
  { value: "m4a", label: "M4A (AAC)", hint: "Default · smallest lossy file" },
  { value: "mp3", label: "MP3", hint: "Plays on anything" },
  { value: "opus", label: "Opus", hint: "Smallest file for speech" },
  { value: "flac", label: "FLAC", hint: "Lossless · maximum compression" },
  { value: "wav", label: "WAV", hint: "Uncompressed · very large" },
];

/** The format the plain download button (no menu) asks for. */
export const DEFAULT_DOWNLOAD_FORMAT: DownloadFormatName = "m4a";
