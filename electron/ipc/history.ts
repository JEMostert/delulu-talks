import { encryptHistory, decryptHistory } from "../services/encryptedHistory";
import { openSync, closeSync, readFileSync, fstatSync } from "node:fs";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { historySelection } from "../services/historyBatch";
import { dialog, session } from "electron";
import type {
  ExportFormat,
  HistoryRetentionPreview,
  MagicPreset,
  TranscriptRecord,
} from "../../src/types";
import { isMagicPreset } from "../../src/rewritePresets";
import {
  deliveredText,
  transcriptSourceRevision,
} from "../../src/transcriptText";
import { normalizeTranscriptTitle } from "../../src/transcriptTitle";
import {
  normalizeTimings,
  withoutRewriteTimings,
} from "../../src/pipelineTimings";
import { rememberSessionTranscript } from "../../src/sessionTranscriptRetention";
import { applyTranscriptEdit } from "../services/storage";
import {
  affectedByRetention,
  historyFingerprint,
  retentionEffects,
  validateRetentionPolicy,
} from "../services/historyRetention";
import { exportRecord, writeExportFile } from "../services/transcripts";
import { deletedDespiteCleanup } from "../services/migrationBackups";
import {
  renderExportTemplate,
  validateExportTemplateRequest,
} from "../../src/exportTemplates";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerHistoryIpc(
  { handle }: IpcRegistrar,
  {
    getMainWindow,
    storage,
    getLastTranscript,
    setLastTranscript,
    sessionTranscripts,
    rebuildTrayMenu,
    getPasteRecovery,
    setPasteRecovery,
    broadcast,
    historyDeletion,
    visibleHistory,
    historyBatchSnapshot,
    selectedHistory,
  }: IpcDependencies,
): void {
  /** The native dialog confirms overwrites, so its exact path must be kept. */
  const chooseExportPath = async (
    options: Electron.SaveDialogOptions,
    extension: string,
  ): Promise<string | null> => {
    const confirmed: Electron.SaveDialogOptions = {
      ...options,
      properties: ["showOverwriteConfirmation"],
    };
    const window = getMainWindow();
    const result = window
      ? await dialog.showSaveDialog(window, confirmed)
      : await dialog.showSaveDialog(confirmed);
    if (result.canceled || !result.filePath) return null;
    // Appending a suffix afterwards would bypass the overwrite confirmation.
    if (extname(result.filePath).toLowerCase() !== `.${extension}`)
      throw new Error(`Choose a filename ending in .${extension}.`);
    return result.filePath;
  };
  const saveExport = (outputPath: string, content: string) =>
    writeExportFile(storage.dataDirectory, outputPath, content);

  handle("history:batchSnapshot", () => historyBatchSnapshot());
  handle("history:stageDeletion", (_event, value: unknown) => {
    const ids = historySelection(value);
    selectedHistory(ids); // Fail all-or-nothing if any selection is stale.
    return historyDeletion.stage(ids);
  });
  handle("history:undoDeletion", (_event, token: unknown) => {
    historyDeletion.undo(validateText(token, 128));
  });
  handle(
    "history:exportSelection",
    async (_event, value: unknown, format: unknown) => {
      const ids = historySelection(value);
      if (format !== "txt" && format !== "json")
        throw new Error("Choose TXT or JSON export.");
      const records = selectedHistory(ids);
      const fingerprint = historyFingerprint(records);
      const outputPath = await chooseExportPath(
        {
          title: `Export ${records.length} transcripts as ${format.toUpperCase()}`,
          defaultPath: `delulu-${records.length}-transcripts.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        },
        format,
      );
      if (!outputPath) return null;
      if (historyFingerprint(selectedHistory(ids)) !== fingerprint)
        throw new Error(
          "Selected transcripts changed while choosing a file. Export the current selection again.",
        );
      const content =
        format === "json"
          ? `${JSON.stringify(records, null, 2)}\n`
          : records
              .map(
                (record, index) =>
                  `=== Transcript ${index + 1} of ${records.length} · ${new Date(record.createdAt).toISOString()} · ${record.id} ===\n${exportRecord(record, "txt")}`,
              )
              .join("\n");
      saveExport(outputPath, content);
      return outputPath;
    },
  );

  let encryptedHistoryBusy = false;
  const saveBackup = async (
    text: string,
    extension: string,
    title: string,
  ): Promise<string | null> => {
    const outputPath = await chooseExportPath(
      {
        title,
        defaultPath: `delulu-history.${extension}`,
        filters: [{ name: "History backup", extensions: [extension] }],
      },
      extension,
    );
    if (!outputPath) return null;
    saveExport(outputPath, text);
    return outputPath;
  };
  handle("history:encryptedExport", async (_event, passphrase: unknown) => {
    if (encryptedHistoryBusy)
      throw new Error("An encrypted-history operation is already running.");
    encryptedHistoryBusy = true;
    try {
      return await saveBackup(
        await encryptHistory(storage.getHistory(), passphrase),
        "delulubak",
        "Save encrypted history",
      );
    } finally {
      encryptedHistoryBusy = false;
    }
  });
  handle("history:encryptedRecover", async (_event, passphrase: unknown) => {
    if (encryptedHistoryBusy)
      throw new Error("An encrypted-history operation is already running.");
    encryptedHistoryBusy = true;
    try {
      const options: Electron.OpenDialogOptions = {
        title: "Choose encrypted history backup",
        properties: ["openFile"],
        filters: [{ name: "Encrypted history", extensions: ["delulubak"] }],
      };
      const selected = getMainWindow()
        ? await dialog.showOpenDialog(getMainWindow()!, options)
        : await dialog.showOpenDialog(options);
      if (selected.canceled || !selected.filePaths[0]) return null;
      const descriptor = openSync(selected.filePaths[0], "r");
      let encoded: string;
      try {
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.size > 90 * 1024 * 1024)
          throw new Error(
            "Choose an encrypted-history file smaller than 90 MB.",
          );
        encoded = readFileSync(descriptor, "utf8");
      } finally {
        closeSync(descriptor);
      }
      return await saveBackup(
        await decryptHistory(encoded, passphrase),
        "json",
        "Save decrypted history outside the active profile",
      );
    } finally {
      encryptedHistoryBusy = false;
    }
  });

  let retentionPreview: {
    preview: HistoryRetentionPreview;
    savedFingerprint: string;
    fullFingerprint: string;
  } | null = null;
  const retentionHistoryFingerprint = (saved: TranscriptRecord[]) =>
    historyFingerprint({ saved, session: [...sessionTranscripts.values()] });
  handle("history:get", () => visibleHistory());
  handle("history:retentionPreview", (_event, value: unknown) => {
    historyDeletion.assertNoPending();
    const policy = validateRetentionPolicy(value);
    const saved = storage.getHistory();
    const previewedAt = Date.now();
    const affected = affectedByRetention(saved, policy, previewedAt);
    const preview: HistoryRetentionPreview = {
      token: randomUUID(),
      policy,
      previewedAt,
      totalSaved: saved.length,
      retainedCount: saved.length - affected.length,
      effects: retentionEffects(affected.map(({ record }) => record)),
      affected,
    };
    retentionPreview = {
      preview,
      savedFingerprint: historyFingerprint(saved),
      fullFingerprint: retentionHistoryFingerprint(saved),
    };
    return preview;
  });
  handle("history:retentionApply", (_event, value: unknown) => {
    historyDeletion.assertNoPending();
    const token = validateText(value, 128);
    const pending = retentionPreview;
    if (!pending || pending.preview.token !== token)
      throw new Error(
        "This retention preview is no longer available. Preview the records again.",
      );
    const saved = storage.getHistory();
    if (retentionHistoryFingerprint(saved) !== pending.fullFingerprint) {
      retentionPreview = null;
      throw new Error(
        "History changed since the preview. Preview the affected records again; nothing was removed.",
      );
    }
    const removedIds = pending.preview.affected.map(({ record }) => record.id);
    if (removedIds.length) {
      // No await between snapshot comparison, durable write and session invalidation.
      storage.applyHistoryRetention(pending.savedFingerprint, removedIds);
      for (const id of removedIds) sessionTranscripts.delete(id);
      if (getLastTranscript() && removedIds.includes(getLastTranscript()!.id))
        setLastTranscript(null);
    }
    retentionPreview = null;
    broadcast("history:retentionApplied", removedIds);
    rebuildTrayMenu();
    return removedIds;
  });
  handle("history:updateTranscript", (_event, id: unknown, text: unknown) => {
    const key = validateText(id, 128);
    if (historyDeletion.hidden(key))
      throw new Error("Undo deletion before using this transcript.");
    const correction = text === null ? null : validateText(text, 500_000);
    const sessionRecord = sessionTranscripts.get(key);
    const updated = storage.findHistory(key)
      ? storage.updateTranscript(key, correction)
      : sessionRecord
        ? applyTranscriptEdit(sessionRecord, correction)
        : null;
    if (!updated) throw new Error("Transcript not found");
    rememberSessionTranscript(
      sessionTranscripts,
      updated,
      historyDeletion.getState()?.ids ?? [],
    );
    if (getLastTranscript()?.id === key) setLastTranscript(updated);
    rebuildTrayMenu();
    return updated;
  });
  handle("history:setTitle", (_event, id: unknown, title: unknown) => {
    const key = validateText(id, 128);
    if (historyDeletion.hidden(key))
      throw new Error("Undo deletion before using this transcript.");
    const normalized = normalizeTranscriptTitle(title);
    const sessionRecord = sessionTranscripts.get(key);
    const updated = storage.findHistory(key)
      ? storage.setTranscriptTitle(key, normalized)
      : sessionRecord
        ? { ...sessionRecord, title: normalized }
        : null;
    if (!updated) throw new Error("Transcript not found");
    // A rejected saved-history write leaves session and last-record state intact.
    rememberSessionTranscript(
      sessionTranscripts,
      updated,
      historyDeletion.getState()?.ids ?? [],
    );
    if (getLastTranscript()?.id === key) setLastTranscript(updated);
    rebuildTrayMenu();
    return updated;
  });
  handle(
    "history:setRewrite",
    (
      _event,
      id: unknown,
      value: unknown,
      expected: unknown,
      expectedRevision: unknown = 0,
    ) => {
      const key = validateText(id, 128);
      if (historyDeletion.hidden(key))
        throw new Error("Undo deletion before using this transcript.");
      const record = storage.findHistory(key) ?? sessionTranscripts.get(key);
      if (!record) throw new Error("Transcript not found");
      if (
        !Number.isSafeInteger(expectedRevision) ||
        Number(expectedRevision) < 0
      )
        throw new Error("Invalid transcript source revision");
      if (
        transcriptSourceRevision(record) !== expectedRevision ||
        deliveredText(record) !== validateText(expected, 500_000)
      )
        throw new Error(
          "This transcript changed while rewriting. Review the current text and try again.",
        );
      let updated: TranscriptRecord;
      if (value === null) {
        updated = {
          ...record,
          magicText: null,
          rewriteSourceRevision: null,
          magicModel: null,
          magicPreset: null,
          magicIncludedInferences: false,
          magicProcessingTimeMs: 0,
          timings: withoutRewriteTimings(record.timings),
        };
      } else {
        if (!value || typeof value !== "object")
          throw new Error("Invalid rewrite");
        const rewrite = value as Record<string, unknown>;
        const text = validateText(rewrite.text, 500_000);
        if (!text.trim()) throw new Error("A rewrite cannot be empty");
        const measured = normalizeTimings(rewrite.timings);
        updated = {
          ...record,
          magicText: text,
          rewriteSourceRevision: transcriptSourceRevision(record),
          magicPreset: isMagicPreset(rewrite.preset)
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
          // Earlier rewrite and delivery timings described different text.
          timings: normalizeTimings({
            ...withoutRewriteTimings(record.timings),
            rewriteLoadMs: measured?.rewriteLoadMs,
            rewritingMs: measured?.rewritingMs,
          }),
        };
      }
      if (storage.findHistory(key)) storage.replaceHistory(updated);
      rememberSessionTranscript(
        sessionTranscripts,
        updated,
        historyDeletion.getState()?.ids ?? [],
      );
      if (getLastTranscript()?.id === key) setLastTranscript(updated);
      rebuildTrayMenu();
      return updated;
    },
  );
  handle("history:delete", (_event, id: unknown) => {
    const key = validateText(id, 128);
    if (historyDeletion.hidden(key))
      throw new Error("Undo deletion before using this transcript.");
    historyDeletion.assertNoPending();
    const cleanupFailure = deletedDespiteCleanup(() =>
      storage.deleteHistory(key),
    );
    sessionTranscripts.delete(key);
    if (getPasteRecovery()?.transcriptId === key) setPasteRecovery(null);
    if (getLastTranscript()?.id === key) setLastTranscript(null);
    rebuildTrayMenu();
    if (cleanupFailure) throw cleanupFailure;
  });
  handle("history:clear", () => {
    historyDeletion.assertNoPending();
    const cleanupFailure = deletedDespiteCleanup(() => storage.clearHistory());
    sessionTranscripts.clear();
    setPasteRecovery(null);
    setLastTranscript(null);
    rebuildTrayMenu();
    if (cleanupFailure) throw cleanupFailure;
  });
  handle(
    "history:exportTemplate",
    async (_event, id: unknown, input: unknown) => {
      const key = validateText(id, 128);
      if (historyDeletion.hidden(key))
        throw new Error("Undo deletion before using this transcript.");
      const request = validateExportTemplateRequest(input);
      const findRecord = () =>
        storage.findHistory(key) ?? sessionTranscripts.get(key);
      const renderCurrent = () => {
        const record = findRecord();
        if (!record) throw new Error("Transcript no longer exists");
        const text = renderExportTemplate(record, request);
        if (text !== request.expectedOutput)
          throw new Error(
            "The transcript changed. Reopen the export preview before saving.",
          );
        return { record, text };
      };
      const { record } = renderCurrent();
      const stem = (record.sourceName ?? `delulu-${record.createdAt}`)
        .replace(/[/\\]/g, "-")
        .replace(/\.[^.]+$/, "");
      const extension = request.extension;
      const outputPath = await chooseExportPath(
        {
          title: "Save transcript template",
          defaultPath: `${stem}.${extension}`,
          filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        },
        extension,
      );
      if (!outputPath) return null;
      const { text } = renderCurrent();
      saveExport(outputPath, text);
      return outputPath;
    },
  );
  handle(
    "history:export",
    async (_event, id: unknown, requestedFormat: ExportFormat) => {
      const key = validateText(id, 128);
      if (historyDeletion.hidden(key))
        throw new Error("Undo deletion before using this transcript.");
      const record = storage.findHistory(key) ?? sessionTranscripts.get(key);
      if (!record) throw new Error("Transcript not found");
      const format = ["txt", "json", "md"].includes(requestedFormat)
        ? requestedFormat
        : "txt";
      const defaultName = `${(record.sourceName ?? `delulu-${record.createdAt}`).replace(/\.[^.]+$/, "")}.${format}`;
      const outputPath = await chooseExportPath(
        {
          title:
            format === "md"
              ? "Export Markdown note"
              : `Export ${format.toUpperCase()}`,
          defaultPath: defaultName,
          filters: [
            {
              name: format === "md" ? "Markdown notes" : format.toUpperCase(),
              extensions: [format],
            },
          ],
        },
        format,
      );
      if (!outputPath) return null;
      // Export the text as it is now, not as it was when the picker opened.
      const current = storage.findHistory(key) ?? sessionTranscripts.get(key);
      if (!current || historyDeletion.hidden(key))
        throw new Error("Transcript no longer exists");
      saveExport(outputPath, exportRecord(current, format));
      return outputPath;
    },
  );
}
