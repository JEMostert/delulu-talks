/** Untrusted backend text is classified, never copied into diagnostic output.
 * These categories are deliberately lossy; unknown text remains undisclosed.
 */
export function backendFailure(value: unknown): { category: string; message: string } {
  const text = value instanceof Error ? value.message : String(value);
  if (/out of memory|OutOfMemoryError|memory allocation|resource exhausted/i.test(text))
    return { category: "memory", message: "The model ran out of memory. Unload the other model or use a smaller rewriting model." };
  if (/ModuleNotFoundError|ImportError|No module named|missing dependency|dependency unavailable/i.test(text))
    return { category: "dependency", message: "A required model dependency is unavailable. Repair this runtime." };
  if (/permission denied|PermissionError|EACCES|access denied/i.test(text))
    return { category: "permission", message: "The runtime cannot access a required local resource. Check permissions and retry." };
  if (/FileNotFoundError|ENOENT|file no longer exists|required file|missing file/i.test(text))
    return { category: "missing-file", message: "A required file is unavailable. Re-select the audio file or repair the runtime." };
  if (/CUDA|cuDNN|cuBLAS|NVIDIA|GPU driver|Metal.*unavailable/i.test(text))
    return { category: "accelerator", message: "The model accelerator failed. Check the GPU driver and runtime setup, then reload the model." };
  if (/not loaded|no model.*loaded|load .*model first/i.test(text))
    return { category: "not-loaded", message: "No model is loaded. Load the model and retry." };
  if (/cancelled|canceled/i.test(text))
    return { category: "cancelled", message: "The model operation was cancelled. Retry when ready." };
  if (/connection|network|download|HTTPError|offline/i.test(text))
    return { category: "download", message: "The model download or connection failed. Check connectivity and retry setup." };
  if (/timed out|timeout/i.test(text))
    return { category: "timeout", message: "The model operation timed out. Reload the model and retry." };
  if (/protocol|JSON|serialization|serialized|UTF-8 bytes|byte limit/i.test(text))
    return { category: "protocol", message: "The model worker protocol failed. Restart the app or repair the runtime." };
  if (/ValueError|TypeError|invalid.*input|input.*invalid|empty.*rewrite|empty.*text/i.test(text))
    return { category: "input", message: "The model rejected its input. Check the audio or text selection and retry." };
  return { category: "backend", message: "The model backend failed. Reload the model or repair its runtime. Backend details were omitted to protect text and local paths." };
}

export function privateFailureLog(
  runtime: "speech" | "magic",
  error: unknown,
  stderr: string,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    runtime,
    ...backendFailure(error),
    diagnosticBytes: Buffer.byteLength(stderr, "utf8"),
    backendOutputIncluded: false,
  }, null, 2) + "\n";
}
