import type { MagicRewriteRequest } from "../../src/types";
import { runtimeDiagnostics } from "../runtime/diagnostics";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerRuntimeIpc(
  { handle }: IpcRegistrar,
  {
    asr,
    dictation,
    storage,
  }: Pick<
    IpcDependencies,
    | "asr"
    | "dictation"
    | "storage"
  >,
): void {
  const assertRuntimeIdle = () => {
    if (dictation.isActive || asr.isBusy)
      throw new Error("Finish the current recording or model operation first");
  };
  handle("runtime:diagnostics", () => runtimeDiagnostics(storage));
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
  handle("magic:rewrite", (_event, value: unknown) => {
    if (!value || typeof value !== "object")
      throw new Error("Expected a Magic rewrite request");
    const source = value as Record<string, unknown>;
    const preset = ["polish", "concise", "structured", "prompt"].includes(
      String(source.preset),
    )
      ? (source.preset as MagicRewriteRequest["preset"])
      : "polish";
    const request: MagicRewriteRequest = {
      text: validateText(source.text, 50_000).trim(),
      preset,
      instructions: validateText(source.instructions ?? "", 4_000).trim(),
      allowInferences: source.allowInferences === true,
    };
    if (!request.text)
      throw new Error("Add a transcript or draft before using Magic");
    assertRuntimeIdle();
    return asr.rewriteMagic(request, storage.getSettings());
  });
}
