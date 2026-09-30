import { bridge } from "./bridge";
import {
  clearCorrectionDrafts,
  discardCorrectionDraft,
} from "./correctionDrafts";
import { ruleConflict, ruleKind, ruleLanguage } from "./personalization";
import type { TranscriptActions } from "./components/TranscriptCard";
import type { useWorkspace } from "./hooks/useWorkspace";
import type {
  CustomWord,
  ExportFormat,
  MagicRewriteResult,
  TranscriptRecord,
} from "./types";

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
> & { history?: TranscriptRecord[] };

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
        ruleLanguage(item) === ruleLanguage(word) &&
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
    ruleExamples: w.settings.keepHistory ? (w.history ?? []) : [],
    onCopy: w.copy,
    onRewrite: bridge.rewriteMagic,
    onCancelRewrite: bridge.cancelRewrite,
    onRewriteSetup: () => w.setPage("models"),
    rewriteStatus: w.magicStatus,
    onSetRewrite: async (
      id: string,
      result: MagicRewriteResult | null,
      sourceText: string,
      expectedSourceRevision?: number,
    ) =>
      w.action(
        async () => {
          const record = await bridge.setTranscriptRewrite(
            id,
            result,
            sourceText,
            expectedSourceRevision,
          );
          w.setHistory((items) =>
            items.map((item) => (item.id === id ? record : item)),
          );
        },
        result ? "Rewrite applied" : "Rewrite undone",
      ),
    onUpdateTranscript: w.updateTranscript,
    onSetTitle: (id, title) =>
      w.action(
        async () => {
          const record = await bridge.setTranscriptTitle(id, title);
          w.setHistory((items) =>
            items.map((item) => (item.id === id ? record : item)),
          );
        },
        title?.trim() ? "Transcript title saved" : "Transcript title removed",
      ),
    onRemember: remember,
    onDelete: (id: string) => {
      void w.action(async () => {
        await bridge.deleteHistory(id);
        discardCorrectionDraft(id);
        w.setHistory((items) => items.filter((item) => item.id !== id));
      }, "Transcript deleted");
    },
    onExportTemplate: async (id, request) => {
      const path = await bridge.exportTranscriptTemplate(id, request);
      if (path) w.setToast("Transcript exported");
      return path;
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
      clearCorrectionDrafts();
      w.setHistory([]);
    }, "History cleared");
  };
  return { actions, onClearHistory };
}
