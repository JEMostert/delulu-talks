import type { RecordingSubmission } from "../../src/types";
import { deliveredText } from "../../src/transcriptText";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerDictationIpc(
  { handle, on }: IpcRegistrar,
  {
    dictation,
    storage,
    paste,
    getLastTranscript,
    sessionTranscripts,
  }: Pick<
    IpcDependencies,
    | "dictation"
    | "storage"
    | "paste"
    | "getLastTranscript"
    | "sessionTranscripts"
  >,
): void {
  handle("dictation:pasteLast", async () => {
    const lastTranscript = getLastTranscript();
    const record = lastTranscript
      ? (storage.findHistory(lastTranscript.id) ?? lastTranscript)
      : storage.getHistory()[0];
    if (!record) throw new Error("Record something first");
    if (dictation.isActive)
      throw new Error("Finish the current recording first");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    if (dictation.isActive)
      throw new Error("Paste cancelled because a recording started");
    const current =
      storage.findHistory(record.id) ?? sessionTranscripts.get(record.id);
    if (!current)
      throw new Error("Paste cancelled because the transcript was removed");
    await paste.paste(deliveredText(current));
  });
  handle("dictation:discardFailed", () => dictation.discardFailure());
  handle("dictation:retry", () => dictation.retry());
  handle("dictation:start", () => dictation.start());
  handle("dictation:stop", () => dictation.stop());
  handle("dictation:toggle", () => dictation.toggle());
  handle("dictation:cancel", () => dictation.cancel());
  handle("recorder:started", () => dictation.recordingStarted());
  handle("recorder:ready", () => dictation.recorderAvailable());
  handle("recorder:failed", (_event, message: unknown) =>
    dictation.recordingFailed(validateText(message, 1000)),
  );
  handle("recorder:submit", (_event, submission: RecordingSubmission) =>
    dictation.submitRecording(submission),
  );
  on("recorder:level", (_event, value: unknown) => {
    const level =
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : 0;
    dictation.recordingLevel(level);
  });
}
