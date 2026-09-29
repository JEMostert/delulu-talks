import { dialog } from "electron";
import { writeFileSync } from "node:fs";
import { extname } from "node:path";
import type { ExportFormat, MagicPreset, TranscriptRecord } from "../../src/types";
import { deliveredText } from "../../src/transcriptText";
import {
  rememberSessionTranscript,
  retainSessionTranscripts,
} from "../../src/sessionTranscriptRetention";
import { applyTranscriptEdit } from "../services/storage";
import { exportRecord } from "../services/transcripts";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerHistoryIpc(
  { handle }: IpcRegistrar,
  {
    storage,
    sessionTranscripts,
    getLastTranscript,
    setLastTranscript,
    rebuildTrayMenu,
    getMainWindow,
  }: Pick<
    IpcDependencies,
    | "storage"
    | "sessionTranscripts"
    | "getLastTranscript"
    | "setLastTranscript"
    | "rebuildTrayMenu"
    | "getMainWindow"
  >,
): void {
  handle("history:get", () => {
    const records = new Map(
      storage.getHistory().map((record) => [record.id, record]),
    );
    for (const [id, record] of sessionTranscripts) records.set(id, record);
    return retainSessionTranscripts([...records.values()])
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500);
  });
  handle("history:updateTranscript", (_event, id: unknown, text: unknown) => {
    const key = validateText(id, 128);
    const correction = text === null ? null : validateText(text, 500_000);
    const sessionRecord = sessionTranscripts.get(key);
    const updated = storage.findHistory(key)
      ? storage.updateTranscript(key, correction)
      : sessionRecord
        ? applyTranscriptEdit(sessionRecord, correction)
        : null;
    if (!updated) throw new Error("Transcript not found");
    rememberSessionTranscript(sessionTranscripts, updated);
    if (getLastTranscript()?.id === key) setLastTranscript(updated);
    rebuildTrayMenu();
    return updated;
  });
  handle(
    "history:setRewrite",
    (_event, id: unknown, value: unknown, expected: unknown) => {
      const key = validateText(id, 128);
      const record = storage.findHistory(key) ?? sessionTranscripts.get(key);
      if (!record) throw new Error("Transcript not found");
      if (deliveredText(record) !== validateText(expected, 500_000))
        throw new Error(
          "This transcript changed while rewriting. Review the current text and try again.",
        );
      let updated: TranscriptRecord;
      if (value === null) {
        updated = {
          ...record,
          magicText: null,
          magicModel: null,
          magicPreset: null,
          magicIncludedInferences: false,
          magicProcessingTimeMs: 0,
        };
      } else {
        if (!value || typeof value !== "object")
          throw new Error("Invalid rewrite");
        const rewrite = value as Record<string, unknown>;
        const text = validateText(rewrite.text, 500_000).trim();
        if (!text) throw new Error("A rewrite cannot be empty");
        updated = {
          ...record,
          magicText: text,
          magicPreset: ["polish", "concise", "structured", "prompt"].includes(
            String(rewrite.preset),
          )
            ? (rewrite.preset as MagicPreset)
            : null,
          magicModel: ["qwen35Small", "qwen35Medium", "qwen35Large"].includes(
            String(rewrite.model),
          )
            ? (rewrite.model as TranscriptRecord["magicModel"])
            : null,
          magicIncludedInferences: rewrite.includedInferences === true,
          magicProcessingTimeMs: Number.isFinite(rewrite.processingTimeMs)
            ? Math.max(0, Number(rewrite.processingTimeMs))
            : 0,
        };
      }
      if (storage.findHistory(key)) storage.replaceHistory(updated);
      rememberSessionTranscript(sessionTranscripts, updated);
      if (getLastTranscript()?.id === key) setLastTranscript(updated);
      rebuildTrayMenu();
      return updated;
    },
  );
  handle("history:delete", (_event, id: unknown) => {
    const key = validateText(id, 128);
    storage.deleteHistory(key);
    sessionTranscripts.delete(key);
    if (getLastTranscript()?.id === key) setLastTranscript(null);
    rebuildTrayMenu();
  });
  handle("history:clear", () => {
    storage.clearHistory();
    sessionTranscripts.clear();
    setLastTranscript(null);
    rebuildTrayMenu();
  });
  handle(
    "history:export",
    async (_event, id: unknown, requestedFormat: ExportFormat) => {
      const key = validateText(id, 128);
      const record = sessionTranscripts.get(key) ?? storage.findHistory(key);
      if (!record) throw new Error("Transcript not found");
      const format = ["txt", "json"].includes(requestedFormat)
        ? requestedFormat
        : "txt";
      const defaultName = `${(record.sourceName ?? `delulu-${record.createdAt}`).replace(/\.[^.]+$/, "")}.${format}`;
      const options: Electron.SaveDialogOptions = {
        title: `Export ${format.toUpperCase()}`,
        defaultPath: defaultName,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      };
      const mainWindow = getMainWindow();
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      const outputPath = extname(result.filePath)
        ? result.filePath
        : `${result.filePath}.${format}`;
      writeFileSync(outputPath, exportRecord(record, format), "utf8");
      return outputPath;
    },
  );
}
