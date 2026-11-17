import { expect, test } from "bun:test";
import type { MusicModel, MusicModelRow } from "./ipc";
import { musicErrorFor, musicGeneralError } from "./useMusicModels";

const row = (id: string, error: string | null = null): MusicModelRow => ({
  id,
  engine: "acestep",
  label: id,
  license: "MIT",
  bytes: 1,
  state: "missing",
  terms: null,
  error,
});
const status = (rows: MusicModelRow[], error: string | null): MusicModel => ({
  models: rows,
  doneBytes: 0,
  totalBytes: 0,
  error,
});

test("a failed download shows on its own model, not on the other missing ones", () => {
  const models = status(
    [row("yue2-3b"), row("ace-step-1.5-dit", "Network error"), row("lm-4b")],
    "Network error",
  );
  expect(musicErrorFor(models, null, "ace-step-1.5-dit")).toBe("Network error");
  expect(musicErrorFor(models, null, "yue2-3b")).toBeNull();
  expect(musicErrorFor(models, null, "lm-4b")).toBeNull();
  expect(musicGeneralError(models, null)).toBeNull();
});

test("a refused action shows on the model it was for", () => {
  const models = status([row("yue2-3b"), row("lm-4b")], null);
  const failure = { text: "Cancel the download first.", ids: ["lm-4b"] };
  expect(musicErrorFor(models, failure, "lm-4b")).toBe(failure.text);
  expect(musicErrorFor(models, failure, "yue2-3b")).toBeNull();
});

test("an error about no model, such as music in a daemon's client, shows once", () => {
  const models = status(
    [row("yue2-3b"), row("lm-4b")],
    "Delulu FM is not available here",
  );
  expect(musicErrorFor(models, null, "yue2-3b")).toBeNull();
  expect(musicGeneralError(models, null)).toBe(
    "Delulu FM is not available here",
  );
});
