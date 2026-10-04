import { delimiter, join } from "node:path";
import type { RuntimeKind } from "./inventory";

/** Package/import and generated-code ownership is independent of version pins.
 * Model weights stay shared to preserve existing downloads.
 */
export function runtimeEnvironment(
  kind: RuntimeKind,
  dataDirectory: string,
  modelCache: string,
  bin: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      /^(?:PYTHON|PIP_)/i.test(key) ||
      /^(?:VIRTUAL_ENV|__PYVENV_LAUNCHER__|CONDA_PREFIX)$/i.test(key)
    )
      delete env[key];
  }
  const generated = join(dataDirectory, "runtime-cache", kind);
  return {
    ...env,
    DELULU_RUNTIME_KIND: kind,
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONPYCACHEPREFIX: join(generated, "python"),
    // Ignore pip's user/global configuration as well as inherited target/prefix.
    PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
    HF_HOME: modelCache,
    HF_HUB_CACHE: join(modelCache, "hub"),
    HUGGINGFACE_HUB_CACHE: join(modelCache, "hub"),
    HF_MODULES_CACHE: join(generated, "hf-modules"),
    TORCH_HOME: join(generated, "torch"),
    TORCH_EXTENSIONS_DIR: join(generated, "torch-extensions"),
    TRITON_CACHE_DIR: join(generated, "triton"),
    PATH: `${bin}${delimiter}${inherited.PATH ?? ""}`,
  };
}
