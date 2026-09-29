export const STARTUP_SERVICE_TIMEOUT_MS = 8_000;

/** Bound one startup read without giving a late reply ownership of UI state. */
export function readStartupService<T>(
  name: string,
  request: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs = STARTUP_SERVICE_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Workspace startup was cancelled"));
      return;
    }
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      complete();
    };
    const cancel = () =>
      finish(() => reject(new Error("Workspace startup was cancelled")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Timed out reading ${name} after ${timeoutMs / 1000} seconds. Retry opening the workspace.`,
            ),
          ),
        ),
      timeoutMs,
    );
    signal.addEventListener("abort", cancel, { once: true });
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new Error("Workspace startup was cancelled");
        return request();
      })
      .then(
        (value) => finish(() => resolve(value)),
        (reason: unknown) => finish(() => reject(reason)),
      );
  });
}
