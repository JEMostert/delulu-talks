export type RecoveryDraft = { label: string; text: string };

/** Session-only copies of recent edits; never included in diagnostic reports. */
export class RecoveryDrafts {
  private values = new Map<string, RecoveryDraft>();

  remember(key: string, label: string, text: string): void {
    this.values.delete(key);
    this.values.set(key, { label, text });
    let characters = [...this.values.values()].reduce(
      (total, draft) => total + draft.text.length,
      0,
    );
    while (this.values.size > 12 || characters > 500_000) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      characters -= this.values.get(oldest)!.text.length;
      this.values.delete(oldest);
    }
  }

  snapshot(): RecoveryDraft[] {
    return [...this.values.values()];
  }
}

export async function boundedRecoveryCall<T>(
  operation: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "The service did not respond within 5 seconds. Try again.",
              ),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function recoveryError(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).slice(
    0,
    4_000,
  );
}
