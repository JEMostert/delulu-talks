import { clipboard } from "electron";

const TEXT_FORMATS = new Set([
  "text/plain",
  "text/plain;charset=utf-8",
  "UTF8_STRING",
  "STRING",
  "TEXT",
]);
const MAX_TEXT_BYTES = 1024 * 1024;
const RESTORE_DELAY_MS = 2000;

type Snapshot = { text: string; formats: string; bytes: Buffer[] };

// Electron has no portable clipboard change counter. Compare every advertised
// format and its bytes throughout the grace period, and invalidate on our writes.
// A replacement with identical bytes between polls cannot be distinguished.
export class ClipboardRestore {
  generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  cancel(): void {
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private snapshot(): Snapshot | null {
    const formats = clipboard.availableFormats().sort();
    const text = clipboard.readText();
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) return null;
    const bytes: Buffer[] = [];
    let total = 0;
    for (const format of formats) {
      const value = clipboard.readBuffer(format);
      total += value.length;
      if (total > MAX_TEXT_BYTES) return null;
      bytes.push(value);
    }
    return { text, formats: JSON.stringify(formats), bytes };
  }

  begin(
    enabled: boolean,
    restore: (text: string) => void,
  ): (() => (() => void) | null) | null {
    this.cancel();
    if (!enabled) return null;
    let previous: string;
    try {
      // Do not replace a rich clipboard with an incomplete plain-text backup.
      if (
        clipboard.availableFormats().some((format) => !TEXT_FORMATS.has(format))
      )
        return null;
      previous = clipboard.readText();
      if (Buffer.byteLength(previous, "utf8") > MAX_TEXT_BYTES) return null;
    } catch {
      return null;
    }
    const generation = this.generation;
    return () => {
      if (generation !== this.generation) return null;
      let snapshot: Snapshot | null;
      try {
        snapshot = this.snapshot();
      } catch {
        return null;
      }
      if (!snapshot) return null;
      const expected = snapshot;
      let deadline = Infinity;
      this.timer = setInterval(() => {
        if (generation !== this.generation) return;
        try {
          const current = this.snapshot();
          if (
            !current ||
            current.text !== expected.text ||
            current.formats !== expected.formats ||
            current.bytes.some(
              (value, index) => !value.equals(expected.bytes[index]),
            )
          ) {
            this.cancel();
            return;
          }
          if (Date.now() >= deadline) {
            this.cancel();
            restore(previous);
          }
        } catch {
          this.cancel();
        }
      }, 50);
      this.timer.unref();
      return () => {
        deadline = Date.now() + RESTORE_DELAY_MS;
      };
    };
  }
}
