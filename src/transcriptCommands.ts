import { bridge } from "./bridge";
import { ruleConflict, ruleKind } from "./personalization";
import type { TranscriptActions } from "./components/TranscriptCard";
import type { useWorkspace } from "./hooks/useWorkspace";
import type { CustomWord, ExportFormat, MagicRewriteResult } from "./types";

type TranscriptWorkspace = Pick<
  ReturnType<typeof useWorkspace>,
  | "settings"
  | "magicStatus"
  | "copy"
  | "updateTranscript"
  | "saveSettings"
  | "action"
  | "setHistory"
  | "setPage"
  | "setToast"
>;

/** Shared record commands; workspace and main IPC retain state/persistence ownership. */
export function createTranscriptCommands(w: TranscriptWorkspace) {
  const remember = (word: CustomWord) => {
    if (w.settings.customWords.length >= 500) {
      return Promise.reject(
        new Error(
          "You have 500 saved rules. Remove one before adding another.",
        ),
      );
    }
    const existing = w.settings.customWords.find(
      (item) =>
        ruleKind(item) === "correction" &&
        item.term.toLowerCase() === word.term.toLowerCase(),
    );
    const conflict = ruleConflict(
      { ...word, id: existing?.id ?? word.id },
      w.settings.customWords,
    );
    if (conflict) {
      return Promise.reject(new Error(conflict));
    }
    return w.saveSettings(
      {
        customWords: existing
          ? w.settings.customWords.map((item) =>
              item.id === existing.id
                ? {
                    ...item,
                    soundsLike: [
                      ...new Set([
                        ...item.soundsLike
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                        word.soundsLike,
                      ]),
                    ].join(", "),
                    enabled: true,
                  }
                : item,
            )
          : [word, ...w.settings.customWords],
      },
      "Correction remembered",
    );
  };
  const actions: TranscriptActions = {
    onCopy: w.copy,
    onRewrite: bridge.rewriteMagic,
    onCancelRewrite: bridge.cancelRewrite,
    onRewriteSetup: () => w.setPage("models"),
    rewriteStatus: w.magicStatus,
    onSetRewrite: async (
      id: string,
      result: MagicRewriteResult | null,
      sourceText: string,
    ) =>
      w.action(
        async () => {
          const record = await bridge.setTranscriptRewrite(
            id,
            result,
            sourceText,
          );
          w.setHistory((items) =>
            items.map((item) => (item.id === id ? record : item)),
          );
        },
        result ? "Rewrite applied" : "Rewrite undone",
      ),
    onUpdateTranscript: w.updateTranscript,
    onRemember: remember,
    onDelete: (id: string) => {
      void w.action(async () => {
        await bridge.deleteHistory(id);
        w.setHistory((items) => items.filter((item) => item.id !== id));
      }, "Transcript deleted");
    },
    onExport: (id: string, format: ExportFormat) => {
      void w.action(async () => {
        const path = await bridge.exportTranscript(id, format);
        if (path) w.setToast("Transcript exported");
      });
    },
  };

  const onClearHistory = () => {
    void w.action(async () => {
      await bridge.clearHistory();
      w.setHistory([]);
    }, "History cleared");
  };
  return { actions, onClearHistory };
}
