export type TechnicalBufferSnapshot = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

export const TECHNICAL_BUFFER_HISTORY_LIMIT = 100;
export const TECHNICAL_BUFFER_HISTORY_CHARACTERS = 2_000_000;
export const TECHNICAL_BUFFER_HISTORY_LIMIT_LABEL =
  "Undo history keeps up to 100 edits within a two-million-character snapshot budget. The newest edit is retained even when unusually large; buffer text is never truncated.";

type Transaction = {
  before: TechnicalBufferSnapshot;
  after: TechnicalBufferSnapshot;
};

function displayText(raw: string): string {
  return raw.replace(/\r\n|\r/g, "\n");
}

/** Textarea offsets are UTF-16 units; each raw CRLF maps to one displayed LF. */
function rawOffset(raw: string, displayedOffset: number): number {
  let rawIndex = 0;
  let displayIndex = 0;
  while (rawIndex < raw.length && displayIndex < displayedOffset) {
    if (raw[rawIndex] === "\r" && raw[rawIndex + 1] === "\n") rawIndex += 2;
    else rawIndex++;
    displayIndex++;
  }
  return rawIndex;
}

function selection(
  text: string,
  start: number,
  end: number,
): Pick<TechnicalBufferSnapshot, "selectionStart" | "selectionEnd"> {
  const length = displayText(text).length;
  const clamp = (offset: number) =>
    Number.isNaN(offset) ? 0 : Math.min(length, Math.max(0, Math.trunc(offset)));
  const first = clamp(start);
  const last = clamp(end);
  return {
    selectionStart: Math.min(first, last),
    selectionEnd: Math.max(first, last),
  };
}

function typedFragment(
  displayed: string,
  style: string,
  prefix: string,
  suffix: string,
): string {
  let raw = displayed.replace(/\n/g, style);
  // Preserve unchanged mixed endings without accidentally fusing two displayed
  // breaks into one CRLF at the edit boundary. Only typed edits get protection;
  // exact insertions deliberately retain their raw characters unchanged.
  if (!raw && prefix.endsWith("\r") && suffix.startsWith("\n")) return "\r";
  if (prefix.endsWith("\r") && raw.startsWith("\n")) raw = "\r" + raw;
  if (raw.endsWith("\r") && suffix.startsWith("\n")) raw += "\r";
  return raw;
}

export class TechnicalBuffer {
  private current: TechnicalBufferSnapshot;
  private readonly past: Transaction[] = [];
  private readonly future: Transaction[] = [];
  private retainedCharacters = 0;

  constructor(text = "") {
    const caret = displayText(text).length;
    this.current = { text, selectionStart: caret, selectionEnd: caret };
  }

  get snapshot(): TechnicalBufferSnapshot {
    return { ...this.current };
  }

  get displayText(): string {
    return displayText(this.current.text);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get historyLimitLabel(): string {
    return TECHNICAL_BUFFER_HISTORY_LIMIT_LABEL;
  }

  select(start: number, end: number): void {
    this.current = { ...this.current, ...selection(this.current.text, start, end) };
  }

  edit(displayValue: string, start: number, end: number): void {
    const previous = this.displayText;
    const next = displayText(displayValue);
    if (previous === next) {
      this.select(start, end);
      return;
    }
    let prefixLength = 0;
    while (
      prefixLength < Math.min(previous.length, next.length) &&
      previous[prefixLength] === next[prefixLength]
    )
      prefixLength++;
    let suffixLength = 0;
    while (
      suffixLength < Math.min(previous.length, next.length) - prefixLength &&
      previous[previous.length - 1 - suffixLength] ===
        next[next.length - 1 - suffixLength]
    )
      suffixLength++;
    const raw = this.current.text;
    const prefix = raw.slice(0, rawOffset(raw, prefixLength));
    const suffix = raw.slice(rawOffset(raw, previous.length - suffixLength));
    const fragment = next.slice(prefixLength, next.length - suffixLength);
    const style = raw.match(/\r\n|\r|\n/)?.[0] ?? "\n";
    const text = prefix + typedFragment(fragment, style, prefix, suffix) + suffix;
    this.commit({ text, ...selection(text, start, end) });
  }

  insert(rawText: string): void {
    const { text, selectionStart, selectionEnd } = this.current;
    const prefix = text.slice(0, rawOffset(text, selectionStart));
    const suffix = text.slice(rawOffset(text, selectionEnd));
    const inserted = prefix + rawText;
    const next = inserted + suffix;
    const caret = displayText(inserted).length;
    this.commit({ text: next, ...selection(next, caret, caret) });
  }

  clear(): void {
    this.commit({ text: "", selectionStart: 0, selectionEnd: 0 });
  }

  undo(): void {
    const transaction = this.past.pop();
    if (!transaction) return;
    this.future.push(transaction);
    this.current = { ...transaction.before };
  }

  redo(): void {
    const transaction = this.future.pop();
    if (!transaction) return;
    this.past.push(transaction);
    this.current = { ...transaction.after };
  }

  private commit(after: TechnicalBufferSnapshot): void {
    if (after.text === this.current.text) {
      this.current = after;
      return;
    }
    // A new text transaction discards redo, while selection-only changes do not.
    for (const transaction of this.future)
      this.retainedCharacters -=
        transaction.before.text.length + transaction.after.text.length;
    this.future.length = 0;
    const transaction = { before: { ...this.current }, after: { ...after } };
    this.past.push(transaction);
    this.retainedCharacters +=
      transaction.before.text.length + transaction.after.text.length;
    this.current = after;
    // Keep the newest transaction even if its snapshots exceed the budget.
    // Eviction only removes old undo states; it never truncates live text.
    while (
      this.past.length > 1 &&
      (this.past.length > TECHNICAL_BUFFER_HISTORY_LIMIT ||
        this.retainedCharacters > TECHNICAL_BUFFER_HISTORY_CHARACTERS)
    ) {
      const discarded = this.past.shift()!;
      this.retainedCharacters -=
        discarded.before.text.length + discarded.after.text.length;
    }
  }
}
