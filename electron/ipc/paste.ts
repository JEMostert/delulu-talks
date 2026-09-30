import { deliveredText } from "../../src/transcriptText";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerPasteIpc(
  { handle }: IpcRegistrar,
  {
    storage,
    paste,
    pill,
    sessionTranscripts,
    getPasteRecovery,
    setPasteRecovery,
  }: Pick<
    IpcDependencies,
    | "storage"
    | "paste"
    | "pill"
    | "sessionTranscripts"
    | "getPasteRecovery"
    | "setPasteRecovery"
  >,
): void {
  handle("paste:recovery", () => getPasteRecovery());
  handle("paste:dismissRecovery", (_event, id: unknown) => {
    const key = validateText(id, 128);
    if (getPasteRecovery()?.transcriptId === key) setPasteRecovery(null);
  });
  handle("paste:copyInstead", (_event, id: unknown) => {
    const key = validateText(id, 128);
    if (getPasteRecovery()?.transcriptId !== key)
      throw new Error(
        "This paste recovery is no longer available. Open History to copy a retained transcript.",
      );
    // Resolve at the moment of the action: edits apply, deleted records never fall back to cached text.
    const record = storage.findHistory(key) ?? sessionTranscripts.get(key);
    if (!record) {
      setPasteRecovery(null);
      throw new Error("The transcript was removed. Nothing was copied.");
    }
    try {
      paste.copy(deliveredText(record));
    } catch (error) {
      const detail = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 500);
      setPasteRecovery({
        transcriptId: key,
        detail: `Copy failed: ${detail}. Try Copy instead again, or open History to select the text manually.`,
      });
      throw new Error("Copy failed. Try again or select the text in History.");
    }
    setPasteRecovery(null);
  });
  handle("platform:capabilities", () =>
    paste.capabilities(pill.method, pill.detail),
  );
  handle("clipboard:copy", (_event, text: unknown) =>
    paste.copy(validateText(text, 500_000)),
  );
  handle("paste:authorize", () => paste.authorize());
  handle("paste:test", async () => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
    await paste.paste("Delulu Talks paste test");
  });
}
