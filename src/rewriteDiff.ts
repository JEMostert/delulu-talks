export type RewriteChange = {
  kind: "unchanged" | "removed" | "added";
  text: string;
};

export type RewriteDiff = {
  changes: RewriteChange[];
  simplified: boolean;
};

// Keep whitespace, punctuation, combining marks and contractions verbatim.
function words(text: string): string[] {
  return (
    text.match(
      /[\p{L}\p{N}\p{M}_]+(?:['’][\p{L}\p{N}\p{M}_]+)*|\s+|[^\p{L}\p{N}\p{M}_\s]/gu,
    ) ?? []
  );
}

// The matrix is capped at 1 million cells (4 MB). Long, unrelated passages
// still get a lossless comparison, with an explicit coarse-comparison label.
const MAX_CELLS = 1_000_000;

export function compareRewrite(source: string, preview: string): RewriteDiff {
  const before = words(source);
  const after = words(preview);
  const changes: RewriteChange[] = [];
  const append = (kind: RewriteChange["kind"], text: string) => {
    if (!text) return;
    const previous = changes[changes.length - 1];
    if (previous?.kind === kind) previous.text += text;
    else changes.push({ kind, text });
  };
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start++;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore--;
    endAfter--;
  }
  append("unchanged", before.slice(0, start).join(""));
  const rows = endBefore - start;
  const columns = endAfter - start;
  const simplified =
    rows > 0 && columns > 0 && (rows + 1) * (columns + 1) > MAX_CELLS;
  if (simplified || rows === 0 || columns === 0) {
    append("removed", before.slice(start, endBefore).join(""));
    append("added", after.slice(start, endAfter).join(""));
  } else {
    const stride = columns + 1;
    const lengths = new Uint32Array((rows + 1) * stride);
    for (let row = rows - 1; row >= 0; row--) {
      for (let column = columns - 1; column >= 0; column--) {
        lengths[row * stride + column] =
          before[start + row] === after[start + column]
            ? 1 + lengths[(row + 1) * stride + column + 1]
            : Math.max(
                lengths[(row + 1) * stride + column],
                lengths[row * stride + column + 1],
              );
      }
    }
    let row = 0;
    let column = 0;
    while (row < rows || column < columns) {
      if (
        row < rows &&
        column < columns &&
        before[start + row] === after[start + column]
      ) {
        append("unchanged", before[start + row++]);
        column++;
      } else if (
        row < rows &&
        (column === columns ||
          lengths[(row + 1) * stride + column] >=
            lengths[row * stride + column + 1])
      ) {
        append("removed", before[start + row++]);
      } else {
        append("added", after[start + column++]);
      }
    }
  }
  append("unchanged", before.slice(endBefore).join(""));
  return { changes, simplified };
}
