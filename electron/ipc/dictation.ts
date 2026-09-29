import { session } from "electron";
import type { RecordingSubmission } from "../../src/types";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerDictationIpc({ handle, on }: IpcRegistrar, { paste, dictation, schedulePasteLast }: Pick<IpcDependencies, "pasteLast" | "paste" | "dictation" | "schedulePasteLast">): void {

handle("dictation:pasteLast", () => schedulePasteLast());
handle("dictation:pasteLastStatus", () => pasteLast.getStatus());
handle("dictation:cancelPasteLast", (_event, operationId: unknown) => {
    if (typeof operationId !== "string")
      throw new Error("Invalid paste operation");
    return pasteLast.cancel(operationId);
  });
handle("dictation:discardFailed", () => dictation.discardFailure());
handle("dictation:retry", () => dictation.retry());
handle("dictation:start", () => dictation.start());
handle("dictation:stop", () => dictation.stop());
handle("dictation:toggle", () => dictation.toggle());
handle("dictation:cancel", () => dictation.cancel());
handle("recorder:started", (_event, sessionId: unknown) =>
    dictation.recordingStarted(validateText(sessionId, 128)),
  );
handle("recorder:limit", (_event, sessionId: unknown) =>
    dictation.recordingLimitReached(validateText(sessionId, 128)),
  );
handle("recorder:ready", () => dictation.recorderAvailable());
handle(
    "recorder:inputChanged",
    (_event, sessionId: unknown, message: unknown, inputLost: unknown) => {
      if (typeof inputLost !== "boolean")
        throw new Error("Invalid microphone change event");
      dictation.recordingInputChanged(
        validateText(sessionId, 128),
        validateText(message, 1000),
        inputLost,
      );
    },
  );
handle("recorder:failed", (_event, message: unknown, sessionId: unknown) =>
    dictation.recordingFailed(
      validateText(message, 1000),
      validateText(sessionId, 128),
    ),
  );
handle("recorder:submit", (_event, submission: RecordingSubmission) => {
    if (typeof submission?.sessionId !== "string" || !submission.sessionId)
      throw new Error("Recording submission requires a capture session ID");
    return dictation.submitRecording(submission);
  });
on("recorder:level", (_event, value: unknown) => {
    const level =
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : 0;
    dictation.recordingLevel(level);
  });
}
