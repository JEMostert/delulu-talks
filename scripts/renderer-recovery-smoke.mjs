import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = await mkdtemp(join(tmpdir(), "delulu-renderer-recovery-"));
const env = {
  ...process.env,
  DELULU_USER_DATA_DIR: data,
  DELULU_SMOKE_TEST: "1",
  HF_HUB_OFFLINE: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

let app;
try {
  // Explicit files prevent startup migration from consulting personal user data.
  await writeFile(join(data, "settings.json"), "{}");
  await writeFile(join(data, "history.json"), "[]");
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({
      workflowVersion: 1,
      onboardingComplete: true,
      preloadModel: false,
      preloadMagicModel: false,
      magicEnabled: false,
      autoPaste: false,
      copyToClipboard: false,
      showOverlay: false,
      keepHistory: true,
    }),
  );
  await writeFile(
    join(data, "history.json"),
    JSON.stringify([
      {
        id: "renderer-recovery-fixture",
        createdAt: Date.now(),
        durationMs: 1200,
        text: "Original speech must survive a workspace failure.",
        editedText: "A saved correction must survive too.",
        model: "r2t2",
        language: "en",
        source: "dictation",
        sourceName: null,
        processingTimeMs: 250,
      },
    ]),
  );

  app = await electron.launch({ args: ["."], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.delulu.getRendererRecoveryState()).canReload,
      ),
    )
    .toBe(true);
  await page.evaluate(() => window.delulu.updateSettings({ theme: "dark" }));

  const before = await page.evaluate(async () => ({
    settings: await window.delulu.getSettings(),
    history: await window.delulu.getHistory(),
  }));
  assert.equal(before.history.length, 1);
  assert.equal(
    before.history[0].text,
    "Original speech must survive a workspace failure.",
  );
  assert.equal(
    before.history[0].editedText,
    "A saved correction must survive too.",
  );
  assert.equal(before.settings.theme, "dark");
  const filesBefore = await Promise.all([
    readFile(join(data, "settings.json"), "utf8"),
    readFile(join(data, "history.json"), "utf8"),
  ]);

  // Exercise the real React render path instead of directly displaying fallback.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    globalThis.__rendererRecoveryLoads = 0;
    window.webContents.on("did-start-loading", () => {
      globalThis.__rendererRecoveryLoads += 1;
    });
    window.webContents.send("app:navigate", "missing-page");
  });
  await expect(
    page.getByRole("heading", { name: "The workspace could not be displayed" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("title");
  assert.deepEqual(
    await page.evaluate(() => window.delulu.getRendererRecoveryState()),
    { canReload: true, reason: null, canStopRecording: false },
  );

  await page
    .getByRole("button", { name: "Copy renderer error", exact: true })
    .click();
  await expect(
    page.getByText("Renderer error copied", { exact: true }),
  ).toBeVisible();
  const copiedError = await app.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  assert.match(copiedError, /title/);
  assert.match(copiedError, /App/);

  await page
    .getByRole("button", { name: "Check diagnostics", exact: true })
    .click();
  await expect(page.getByLabel("Recovery diagnostics")).toBeVisible({
    timeout: 20_000,
  });
  const diagnostics = JSON.parse(
    await page.getByLabel("Recovery diagnostics").textContent(),
  );
  assert.equal(diagnostics.dataDirectory, data);
  assert.equal(diagnostics.runtimeInstalled, false);
  await page
    .getByRole("button", { name: "Copy diagnostics", exact: true })
    .click();
  await expect(
    page.getByText("Diagnostics copied", { exact: true }),
  ).toBeVisible();
  assert.deepEqual(
    JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText())),
    diagnostics,
  );

  await expect(
    page.getByRole("button", { name: "Reload workspace", exact: true }),
  ).toBeEnabled();
  // The IPC response may vanish when its own renderer reloads; observe navigation
  // rather than awaiting the invoke promise inside the destroyed JS context.
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Reload workspace", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The workspace could not be displayed" }),
  ).toHaveCount(0);
  assert.equal(await app.evaluate(() => globalThis.__rendererRecoveryLoads), 1);

  assert.deepEqual(
    await page.evaluate(async () => ({
      settings: await window.delulu.getSettings(),
      history: await window.delulu.getHistory(),
    })),
    before,
  );
  assert.deepEqual(
    await Promise.all([
      readFile(join(data, "settings.json"), "utf8"),
      readFile(join(data, "history.json"), "utf8"),
    ]),
    filesBefore,
  );
  console.log(
    "Electron renderer recovery passed: render fault, cause and diagnostics copying, one guarded reload, settings and original/corrected transcript preservation. No model download or native inference was exercised.",
  );
} finally {
  await app?.close();
  await rm(data, { recursive: true, force: true });
}
