import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const data = await mkdtemp(join(tmpdir(), "delulu-local-data-smoke-"));
const fixture = {
  "history.json": "[]",
  "settings.json": JSON.stringify({
    workflowVersion: 1,
    onboardingComplete: true,
    preloadModel: false,
    preloadMagicModel: false,
    showOverlay: false,
  }),
  "models/hub/blobs/fixture": "model fixture",
  "audio-cache/failed.wav": "retained fixture",
  "asr-venv/fixture": "legacy runtime fixture",
};
let app;
try {
  for (const [relative, bytes] of Object.entries(fixture)) {
    await mkdir(join(data, relative, ".."), { recursive: true });
    await writeFile(join(data, relative), bytes);
  }
  const env = {
    ...process.env,
    DELULU_USER_DATA_DIR: data,
    DELULU_SMOKE_TEST: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ["."], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
  // Startup normalizes settings; take preservation snapshot after startup.
  const settings = await readFile(join(data, "settings.json"), "utf8");
  const overview = await page.evaluate(() =>
    window.delulu.getLocalDataOverview(),
  );
  assert.equal(overview.dataDirectory, data);
  assert.deepEqual(
    overview.categories.map((category) => category.id),
    ["history", "settings", "models", "runtimes", "audio"],
  );
  assert.equal(
    overview.categories.find((category) => category.id === "models")
      .locations[0].bytes,
    Buffer.byteLength(fixture["models/hub/blobs/fixture"]),
  );
  const runtimes = overview.categories.find(
    (category) => category.id === "runtimes",
  ).locations;
  assert.deepEqual(
    runtimes.map((location) => location.status),
    ["missing", "missing", "present"],
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("tab", { name: "Local data", exact: true }).click();
  const region = page.getByRole("region", { name: "Local data overview" });
  await expect(
    region.getByRole("region", { name: "Temporary audio" }),
  ).toContainText("16 B");
  await expect(region.getByRole("region", { name: "Runtimes" })).toContainText(
    "Not present",
  );
  await writeFile(join(data, "audio-cache/new.wav"), "12345");
  await region
    .getByRole("button", { name: "Refresh local data", exact: true })
    .click();
  await expect(
    region.getByRole("region", { name: "Temporary audio" }),
  ).toContainText("21 B · 2 files");
  for (const [relative, bytes] of Object.entries(fixture))
    assert.equal(
      await readFile(join(data, relative), "utf8"),
      relative === "settings.json" ? settings : bytes,
    );
  console.log(
    "Real isolated Electron preload/IPC/UI local data inventory and refresh passed; fixture bytes preserved. No native inference.",
  );
} finally {
  await app?.close();
  await rm(data, { recursive: true, force: true });
}
