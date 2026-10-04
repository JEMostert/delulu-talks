import { describe, expect, test } from "bun:test";
import {
  TechnicalBuffer,
  TECHNICAL_BUFFER_HISTORY_CHARACTERS,
} from "../../src/technicalBuffer";
import { renderTechnicalDictation } from "../../src/technicalDictation";

describe("technical editing preserves exact user text", () => {
  test("inserts using displayed offsets while retaining mixed line endings through undo and redo", () => {
    const original = "alpha\r\nbeta\rgamma\ndelta";
    const buffer = new TechnicalBuffer(original);
    buffer.select(6, 10);
    const before = buffer.snapshot;
    buffer.applyInsert(buffer.captureTarget(), "X\r\n\tY");
    const after = {
      text: "alpha\r\nX\r\n\tY\rgamma\ndelta",
      selectionStart: 10,
      selectionEnd: 10,
    };
    expect(buffer.snapshot).toEqual(after);
    buffer.undo();
    expect(buffer.snapshot).toEqual(before);
    buffer.redo();
    expect(buffer.snapshot).toEqual(after);
    buffer.edit("alpha\nX\n\tY!\ngamma\ndelta", 11, 11);
    expect(buffer.snapshot.text).toBe("alpha\r\nX\r\n\tY!\rgamma\ndelta");
    buffer.undo();
    expect(buffer.snapshot).toEqual(after);
  });

  test("rejects stale or fabricated insertion approvals and consumes even an approved empty insertion", () => {
    const buffer = new TechnicalBuffer("private source");
    const selectionTarget = buffer.captureTarget();
    buffer.select(0, 7);
    expect(() => buffer.applyInsert(selectionTarget, "wrong")).toThrow(
      "changed",
    );
    const documentTarget = buffer.captureTarget();
    buffer.edit("new source", 0, 0);
    expect(() => buffer.applyInsert(documentTarget, "wrong")).toThrow(
      "changed",
    );
    const current = buffer.captureTarget();
    expect(() => buffer.applyInsert({ ...current }, "wrong")).toThrow(
      "changed",
    );
    buffer.applyInsert(current, "");
    expect(() => buffer.applyInsert(current, "wrong")).toThrow("changed");
    expect(buffer.snapshot.text).toBe("new source");
    expect(buffer.canUndo).toBe(true);
  });

  test("evicts old undo snapshots without truncating an oversized edit or losing its undo", () => {
    const buffer = new TechnicalBuffer("original");
    buffer.insert(" previous");
    const oversized = "x".repeat(TECHNICAL_BUFFER_HISTORY_CHARACTERS + 1);
    buffer.select(0, buffer.displayText.length);
    buffer.insert(oversized);
    expect(buffer.snapshot.text).toBe(oversized);
    buffer.undo();
    expect(buffer.snapshot.text).toBe("original previous");
    expect(buffer.canUndo).toBe(false);
    buffer.redo();
    expect(buffer.snapshot.text).toBe(oversized);
  });

  test("renders explicit code and command grammar without reinterpreting literals or ordinary prose", () => {
    const speech =
      "const camel case HTTP client end identifier equals literal dot new line\ttab return literal space";
    expect(renderTechnicalDictation(speech, "code")).toBe(
      "const httpClient = dot\n\t\treturn space",
    );
    expect(
      renderTechnicalDictation("git status double dash short", "command"),
    ).toBe("git status --short");
    expect(renderTechnicalDictation(speech, "prose")).toBe(speech);
    expect(
      renderTechnicalDictation(
        "camel case invalid-name end identifier",
        "code",
      ),
    ).toBe("camel case invalid-name end identifier");
  });
});

test("an operator keeps its space before an opening bracket", () => {
  expect(
    renderTechnicalDictation(
      "x equals open paren a plus b close paren",
      "code",
    ),
  ).toBe("x = (a + b)");
});
