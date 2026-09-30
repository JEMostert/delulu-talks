import { open } from "node:fs/promises";
import { extname } from "node:path";

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const MIME_TYPES: Record<string, string> = {
  wav: "audio/wav", flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4",
  ogg: "audio/ogg", opus: "audio/ogg", aac: "audio/aac", webm: "audio/webm",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
};

export async function loadLinkedAudio(path: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("The linked source is not a regular file");
    if (info.size > MAX_PREVIEW_BYTES)
      throw new Error("In-app audio review supports source files up to 32 MiB. Transcription remains available for larger files.");
    // Bound the read even if another application grows the source concurrently.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error("The source changed while opening; open the review again");
    if (!length) throw new Error("The linked source is empty");
    return { bytes: new Uint8Array(buffer.subarray(0, length)), mime: MIME_TYPES[extname(path).slice(1).toLowerCase()] ?? "" };
  } finally {
    await file.close();
  }
}
