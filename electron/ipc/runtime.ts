import { normalizeRewriteContext } from "../../src/rewriteContext";
import type { MagicRewriteRequest } from "../../src/types";
import { isMagicPreset } from "../../src/rewritePresets";
import { validateRewriteInstructions } from "../../src/rewriteInstructions";
import { runtimeSetupSnapshot } from "../runtime/setupSnapshot";
import { runtimeDiagnostics } from "../runtime/diagnostics";
import { localDataOverview } from "../services/localData";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerRuntimeIpc({ handle }: IpcRegistrar, { storage, asr, dictation, settingsBusy, modelCache }: Pick<IpcDependencies, "storage" | "asr" | "dictation" | "settingsBusy" | "modelCache">): void {
const assertRuntimeIdle = () => { if (dictation.isActive || asr.isBusy) throw new Error("Finish the current recording or model operation first"); };
handle("runtime:diagnostics", () => runtimeDiagnostics(storage));
handle("cache:preview", () => modelCache.preview());
handle("cache:cleanup", (_event, token: unknown, ids: unknown) => {
    assertRuntimeIdle();
    if (settingsBusy())
      throw new Error("Wait for settings to finish saving before cleaning the cache");
    const unloaded = new Set(["unloaded", "missing"]);
    if (
      !unloaded.has(asr.getStatus().engine) ||
      !unloaded.has(asr.getMagicStatus().engine)
    )
      throw new Error("Explicitly unload speech and rewriting before deleting cached models");
    if (
      typeof token !== "string" || token.length > 128 ||
      !Array.isArray(ids) || ids.length === 0 || ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || id.length > 512)
    )
      throw new Error("Select cached models from a fresh preview");
    // Stay synchronous after the authoritative idle/residency checks: another
    // IPC request cannot start loading a model between the guard and deletion.
    return modelCache.cleanup(token, ids as string[]);
  });
handle("runtime:setupSnapshot", () => runtimeSetupSnapshot(storage));
handle("runtime:setupLog", (_event, kind: unknown) => {
    if (kind !== "speech" && kind !== "rewrite")
      throw new Error("Choose speech or rewriting setup logs");
    return asr.getSetupLog(kind);
  });
handle("storage:overview", () => localDataOverview(storage));
handle("runtime:status", () => asr.getStatus());
handle("runtime:setup", () => {
    assertRuntimeIdle();
    return asr.setup(storage.getSettings());
  });
handle("runtime:load", () => {
    assertRuntimeIdle();
    return asr.loadModel(storage.getSettings());
  });
handle("runtime:unload", () => {
    assertRuntimeIdle();
    return asr.unload();
  });
handle("runtime:reset", () => {
    assertRuntimeIdle();
    return asr.reset();
  });
handle("magic:status", () => asr.getMagicStatus());
handle("magic:setup", () => {
    assertRuntimeIdle();
    return asr.setupMagic(storage.getSettings());
  });
handle("magic:load", () => {
    assertRuntimeIdle();
    return asr.loadMagic(storage.getSettings());
  });
handle("magic:unload", () => {
    assertRuntimeIdle();
    return asr.unloadMagic();
  });
handle("magic:cancelRewrite", (_event, id: unknown) => {
 if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid rewrite operation ID");
 return asr.cancelRewrite(id);
});
handle("magic:rewrite", (_event, value: unknown) => {
    if (!value || typeof value !== "object")
      throw new Error("Expected a rewriting request");
    const source = value as Record<string, unknown>;
    const preset = isMagicPreset(source.preset)
      ? (source.preset as MagicRewriteRequest["preset"])
      : "polish";
    const request: MagicRewriteRequest = {
      context: normalizeRewriteContext(source.context),
      operationId: source.operationId == null ? undefined : validateText(source.operationId,128),
      text: validateText(source.text, 50_000),
      preset,
      instructions: validateRewriteInstructions(source.instructions),
      sourceLanguage: source.sourceLanguage == null
        ? undefined
        : validateText(source.sourceLanguage, 64).trim(),
      allowInferences: source.allowInferences === true,
    };
    if (!request.text.trim())
      throw new Error("Add a transcript or draft before rewriting");
    assertRuntimeIdle();
    return asr.rewriteMagic(request, storage.getSettings());
  });
}
