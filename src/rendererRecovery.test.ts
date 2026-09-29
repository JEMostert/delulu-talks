import { expect, test } from "bun:test";
import { RecoveryDrafts } from "./rendererRecovery";

test("recent edits preserve Unicode, whitespace and deliberately emptied drafts", () => {
  const drafts = new RecoveryDrafts();
  drafts.remember("a", "Correction", " café\nمرحبا 👋 ");
  drafts.remember("b", "Instructions", "Shorten");
  drafts.remember("b", "Instructions", "");
  expect(drafts.snapshot()).toEqual([
    { label: "Correction", text: " café\nمرحبا 👋 " },
    { label: "Instructions", text: "" },
  ]);
});

test("recovery holds only the most recent bounded session edits", () => {
  const drafts = new RecoveryDrafts();
  for (let index = 0; index < 15; index++)
    drafts.remember(String(index), "Edit", String(index));
  expect(drafts.snapshot()).toHaveLength(12);
  expect(drafts.snapshot()[0].text).toBe("3");
  drafts.remember("latest", "Long correction", "a".repeat(500_000));
  expect(drafts.snapshot()).toHaveLength(1);
  drafts.remember("oversize", "Too large", "b".repeat(500_001));
  expect(drafts.snapshot()).toEqual([]);
});
