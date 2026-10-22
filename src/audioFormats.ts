export const SUPPORTED_AUDIO_EXTENSIONS = [
  "wav",
  "flac",
  "mp3",
  "m4a",
  "ogg",
  "opus",
  "webm",
  "mp4",
  "mov",
  "mkv",
  "aac",
];

export const MAX_AUDIO_BATCH_FILES = 50;
export const MAX_AUDIO_FILE_BYTES = 500 * 1024 * 1024;

/** Playback MIME types for in-app review; empty lets the webview sniff. */
const AUDIO_MIME_TYPES: Record<string, string> = {
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  aac: "audio/aac",
  webm: "audio/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

export function audioMimeType(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? (AUDIO_MIME_TYPES[name.slice(dot + 1).toLowerCase()] ?? "")
    : "";
}
