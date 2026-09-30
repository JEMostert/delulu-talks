import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import type { AudioFileMetadata } from "../../src/types";
import { runtimePython } from "../runtime/location";
import type { StorageService } from "./storage";

/** Read metadata only: no model startup, conversion, download or disk output. */
function probe(program: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      {
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 128 * 1024,
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export async function inspectMedia(
  path: string,
  storage: StorageService,
): Promise<AudioFileMetadata> {
  const direct = [".wav", ".flac", ".ogg", ".opus"].includes(
    extname(path).toLowerCase(),
  );
  const result: AudioFileMetadata = {
    durationSeconds: null,
    channels: null,
    sampleRate: null,
    decoder: direct ? "soundfile" : "FFmpeg",
    decoderReady: false,
    decoderDetail: "Decoder availability could not be confirmed.",
    estimatedPcmBytes: null,
    processingTimeEstimate:
      "Unknown: depends on recording length, model and hardware; model loading adds time.",
  };
  if (direct) {
    let python: string | null = null;
    try {
      python = runtimePython(storage.venvDirectory);
    } catch {
      /* Repair is separate. */
    }
    const metadata =
      python && existsSync(python)
        ? await probe(python, [
            "-B",
            "-c",
            "import json,sys,soundfile as sf; i=sf.info(sys.argv[1]); print(json.dumps({'duration':i.duration,'channels':i.channels,'sample_rate':i.samplerate}))",
            path,
          ])
        : null;
    if (metadata) {
      try {
        const info = JSON.parse(metadata);
        result.durationSeconds = positive(info.duration);
        result.channels = positive(info.channels);
        result.sampleRate = positive(info.sample_rate);
        result.decoderReady = true;
        result.decoderDetail =
          "Speech runtime soundfile opened this file's header. Full audio decoding happens when you start.";
      } catch {
        /* Metadata stays explicitly unknown. */
      }
    } else {
      result.decoderDetail =
        "Speech runtime soundfile is unavailable or could not open this file. Set up or repair Speech in Models, or choose a readable file.";
    }
  }
  const [metadata, ffmpeg] = await Promise.all([
    result.durationSeconds !== null && result.channels !== null
      ? Promise.resolve(null)
      : probe("ffprobe", [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=duration,channels,sample_rate:format=duration",
          "-of",
          "json",
          path,
        ]),
    direct ? Promise.resolve(null) : probe("ffmpeg", ["-version"]),
  ]);
  if (metadata) {
    try {
      const info = JSON.parse(metadata);
      const stream = info.streams?.[0];
      if (stream) {
        result.durationSeconds ??=
          positive(stream.duration) ?? positive(info.format?.duration);
        result.channels ??= positive(stream.channels);
        result.sampleRate ??= positive(stream.sample_rate);
      } else if (!direct) {
        result.decoderDetail = "No audio stream found in this file.";
        return result;
      }
    } catch {
      /* Missing metadata does not invent duration or channel counts. */
    }
  }
  if (!direct) {
    result.decoderReady = ffmpeg !== null;
    result.decoderDetail = ffmpeg
      ? "FFmpeg is available for local conversion. Full audio decoding happens when you start."
      : "FFmpeg is missing or did not respond. Install FFmpeg before transcribing this format.";
  }
  if (result.durationSeconds !== null) {
    result.estimatedPcmBytes = Math.ceil(result.durationSeconds * 16_000 * 2);
  }
  return result;
}
