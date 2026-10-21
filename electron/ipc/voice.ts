import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { clipboard, dialog } from "electron";
import type { AppSettings } from "../../src/types";
import type { VoicePlaybackEvent, VoiceSpeakRequest } from "../../src/voice";
import type { IpcDependencies, IpcRegistrar } from "./types";

const REFERENCE_EXTENSIONS = ["wav", "flac", "mp3", "ogg"];
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;

export function registerVoiceIpc(
  { handle, on }: IpcRegistrar,
  {
    voice,
    storage,
    persistSettings,
    voiceAgentSetup,
    getMainWindow,
  }: Pick<
    IpcDependencies,
    | "voice"
    | "storage"
    | "persistSettings"
    | "voiceAgentSetup"
    | "getMainWindow"
  >,
): void {
  const references = join(storage.voiceDirectory, "references");
  const removeClip = (name: string) => {
    if (name) rmSync(join(references, name), { force: true });
  };

  handle("voice:status", () => voice.getStatus());
  handle("voice:setup", () => voice.setup(storage.getSettings()));
  handle("voice:cancelSetup", () => voice.cancelSetup());
  handle("voice:load", () => voice.load(storage.getSettings()));
  handle("voice:unload", () => voice.unload());
  handle("voice:speak", (_event, request: VoiceSpeakRequest) =>
    voice.speak(request),
  );
  handle("voice:stop", () => voice.stop("user"));
  handle("voice:speakClipboard", () => {
    // The sandboxed renderer cannot read the clipboard; main reads it on request.
    const text = clipboard.readText().trim();
    if (!text) return null;
    return voice.speak({ text, source: "clipboard", interrupt: true });
  });
  handle("voice:agentSetup", () => voiceAgentSetup());
  handle("voice:chooseReference", async (): Promise<AppSettings | null> => {
    const window = getMainWindow();
    const options = {
      title: "Choose a voice clip",
      buttonLabel: "Use this clip",
      properties: ["openFile" as const],
      filters: [{ name: "Audio", extensions: REFERENCE_EXTENSIONS }],
    };
    const choice = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const path = choice.filePaths[0];
    if (choice.canceled || !path) return null;
    const extension = extname(path).slice(1).toLowerCase();
    if (!REFERENCE_EXTENSIONS.includes(extension))
      throw new Error("Choose a WAV, FLAC, MP3 or Ogg audio file");
    const size = statSync(path).size;
    if (!size) throw new Error("That audio file is empty");
    if (size > MAX_REFERENCE_BYTES)
      throw new Error(
        "Choose a clip smaller than 50 MB; 5–20 seconds is enough",
      );
    // Keep a private copy so the clip still works if the original moves.
    mkdirSync(references, { recursive: true, mode: 0o700 });
    const name = `${randomUUID()}.${extension}`;
    copyFileSync(path, join(references, name));
    const previous = storage.getSettings().voiceClone;
    try {
      const saved = await persistSettings({ voiceClone: name });
      if (previous && previous !== name) removeClip(previous);
      return saved;
    } catch (error) {
      removeClip(name);
      throw error;
    }
  });
  handle("voice:removeReference", async () => {
    const previous = storage.getSettings().voiceClone;
    const saved = await persistSettings({ voiceClone: "" });
    removeClip(previous);
    return saved;
  });
  on("voice:playback", (_event, event: VoicePlaybackEvent) =>
    voice.playbackEvent(event),
  );
}
