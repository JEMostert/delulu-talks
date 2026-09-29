import type { TargetPlatform } from "./inventory";

export enum RuntimePrerequisiteCode {
  PYTHON_VERSION = "PYTHON_VERSION",
  PYTHON_ARCHITECTURE = "PYTHON_ARCHITECTURE",
  CUDA_BUILD = "CUDA_BUILD",
  CUDA_UNAVAILABLE = "CUDA_UNAVAILABLE",
  METAL_UNAVAILABLE = "METAL_UNAVAILABLE",
  PACKAGE_IMPORT = "PACKAGE_IMPORT",
}

const guidance: Record<RuntimePrerequisiteCode, string> = {
  PYTHON_VERSION:
    "Install a supported Python interpreter and set its full path in Settings → Advanced: native arm64 Python 3.12 for MLX, x64 Python 3.12 for Windows, or x64 Python 3.11–3.13 for Linux.",
  PYTHON_ARCHITECTURE:
    "Use native arm64 Python for MLX (no Rosetta), or 64-bit x64 Python for Windows/Linux. Set its full path in Settings → Advanced.",
  CUDA_BUILD:
    "Repair the runtime to install CUDA-enabled PyTorch. A CPU-only PyTorch build cannot run R2T2 speech.",
  CUDA_UNAVAILABLE:
    "R2T2 requires an available NVIDIA CUDA GPU. Install or update the NVIDIA driver, make the GPU accessible to this app, then retry setup.",
  METAL_UNAVAILABLE:
    "R2T2 MLX requires Apple Silicon, native arm64 Python 3.12 and macOS 15 or later. Update macOS and select the native interpreter, then retry setup.",
  PACKAGE_IMPORT:
    "Repair the runtime to reinstall compatible packages. If setup still fails, check the package error below.",
};

export class RuntimePrerequisiteError extends Error {
  readonly details: string;
  constructor(
    readonly code: RuntimePrerequisiteCode,
    details: string,
    options?: ErrorOptions,
  ) {
    const bounded = details.slice(-8000);
    super(`[${code}] ${guidance[code]} ${bounded}`, options);
    this.name = "RuntimePrerequisiteError";
    this.details = bounded;
  }
}

export type PythonInterpreterProbe = {
  version: [number, number, number];
  machine: string;
  bits: number;
};

export const PYTHON_INTERPRETER_PROBE =
  "import json,platform,struct,sys; print(json.dumps({'version':list(sys.version_info[:3]),'machine':platform.machine(),'bits':struct.calcsize('P')*8}))";

export function validatePythonInterpreter(
  output: string,
  target: TargetPlatform,
  metal: boolean,
): PythonInterpreterProbe {
  let probe: PythonInterpreterProbe;
  try {
    probe = JSON.parse(output);
    if (
      !Array.isArray(probe.version) ||
      probe.version.length !== 3 ||
      !probe.version.every(Number.isInteger) ||
      typeof probe.machine !== "string" ||
      !Number.isInteger(probe.bits)
    )
      throw new Error("Invalid interpreter metadata");
  } catch (cause) {
    throw new RuntimePrerequisiteError(
      RuntimePrerequisiteCode.PYTHON_VERSION,
      `Python did not return valid interpreter metadata: ${output.slice(-1000)}`,
      { cause },
    );
  }
  const [major, minor] = probe.version;
  if (
    major !== 3 ||
    (metal || target.platform === "win32"
      ? minor !== 12
      : minor < 11 || minor > 13)
  )
    throw new RuntimePrerequisiteError(
      RuntimePrerequisiteCode.PYTHON_VERSION,
      `Found Python ${probe.version.join(".")}, ${probe.machine}, ${probe.bits}-bit for ${target.platform}/${target.arch}.`,
    );
  const machine = probe.machine.toLowerCase();
  const nativeArm = machine === "arm64" || machine === "aarch64";
  const nativeX64 = machine === "x86_64" || machine === "amd64" || machine === "x64";
  if (
    probe.bits !== 64 ||
    (metal
      ? target.platform !== "darwin" || target.arch !== "arm64" || !nativeArm
      : target.platform === "win32" || target.platform === "linux"
        ? target.arch !== "x64" || !nativeX64
        : target.arch === "arm64" && !nativeArm)
  )
    throw new RuntimePrerequisiteError(
      RuntimePrerequisiteCode.PYTHON_ARCHITECTURE,
      `Found Python ${probe.version.join(".")}, ${probe.machine}, ${probe.bits}-bit for ${target.platform}/${target.arch}.`,
    );
  return probe;
}

const MARKER = "@delulu-prerequisite:";

export function parseRuntimePrerequisiteError(
  diagnostic: string,
  cause: Error,
): RuntimePrerequisiteError | null {
  for (const line of diagnostic.split(/\r?\n/).reverse()) {
    if (!line.startsWith(MARKER)) continue;
    try {
      const value = JSON.parse(line.slice(MARKER.length));
      if (
        Object.values(RuntimePrerequisiteCode).includes(value.code) &&
        typeof value.details === "string"
      )
        return new RuntimePrerequisiteError(value.code, value.details, { cause });
    } catch {
      // Ordinary backend output remains available when no valid marker exists.
    }
  }
  return null;
}

/** Import and hardware availability checks only; never load or download models. */
export function runtimeReadinessScript(
  kind: "speech" | "magic",
  target: TargetPlatform,
  metal: boolean,
): string {
  const version = metal || target.platform === "win32"
    ? "sys.version_info[:2] == (3, 12)"
    : "sys.version_info.major == 3 and 11 <= sys.version_info.minor <= 13";
  const architecture = metal
    ? target.platform === "darwin" && target.arch === "arm64"
      ? "platform.machine().lower() in ('arm64', 'aarch64')"
      : "False"
    : target.platform === "win32" || target.platform === "linux"
      ? target.arch === "x64"
        ? "platform.machine().lower() in ('x86_64', 'amd64', 'x64')"
        : "False"
      : target.arch === "arm64"
        ? "platform.machine().lower() in ('arm64', 'aarch64')"
        : "True";
  const imports = kind === "magic"
    ? "import torch, torchvision, transformers\n    from transformers import AutoModelForMultimodalLM, AutoProcessor\n    if int(transformers.__version__.split('.')[0]) < 5:\n        fail('PACKAGE_IMPORT', 'Magic requires transformers 5 or later')"
    : metal
      ? "import mlx.core as mx\n    from mlx_audio.stt.utils import load_model, load_audio"
      : target.platform === "win32"
        ? "import torch, soundfile, soxr\n    from transformers import Qwen3ASRConfig, Qwen3ASRForConditionalGeneration, Qwen3ASRProcessor, Qwen3ASRFeatureExtractor"
        : "import torch\n    from qwen_asr import Qwen3ASRModel";
  const hardware = kind !== "speech"
    ? ""
    : metal
      ? `try:
    if not mx.metal.is_available():
        fail('METAL_UNAVAILABLE', 'mlx.core reports Metal unavailable')
except Exception as exc:
    fail('METAL_UNAVAILABLE', repr(exc))`
      : `if torch.version.cuda is None:
    fail('CUDA_BUILD', 'torch.version.cuda is None')
try:
    if not torch.cuda.is_available():
        fail('CUDA_UNAVAILABLE', 'torch.cuda.is_available() is false')
except Exception as exc:
    fail('CUDA_UNAVAILABLE', repr(exc))`;
  return `import json, platform, struct, sys
def fail(code, details):
    print('${MARKER}' + json.dumps({'code': code, 'details': str(details)[-1000:]}), file=sys.stderr, flush=True)
    raise SystemExit(1)
interpreter = 'Python ' + platform.python_version() + ', ' + platform.machine() + ', ' + str(struct.calcsize('P') * 8) + '-bit'
if not (${version}):
    fail('PYTHON_VERSION', 'Found ' + interpreter)
if struct.calcsize('P') * 8 != 64 or not (${architecture}):
    fail('PYTHON_ARCHITECTURE', 'Found ' + interpreter)
try:
    ${imports}
except Exception as exc:
    fail('PACKAGE_IMPORT', repr(exc))
${hardware}
`;
}
