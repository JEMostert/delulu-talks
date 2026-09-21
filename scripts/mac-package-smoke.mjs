import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin")
  throw new Error("Run this package check on macOS");
const source = resolve(process.argv[2] ?? "release/mac-arm64/Delulu Talks.app");
const runtime = process.argv[3] ? resolve(process.argv[3]) : null;
const root = await mkdtemp(join(tmpdir(), "delulu-mac-package-"));
const profile = join(root, "profile");
const installed = join(root, "Applications", "Delulu Talks.app");
const env = {
  ...process.env,
  DELULU_USER_DATA_DIR: profile,
  DELULU_SMOKE_TEST: "1",
  HF_HUB_OFFLINE: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({
      workflowVersion: 1,
      onboardingComplete: true,
      model: "r2t2",
      language: "nl",
      preloadModel: false,
      preloadMagicModel: false,
      magicEnabled: false,
      theme: "light",
      showOverlay: false,
    }),
  );
  await writeFile(
    join(profile, "history.json"),
    JSON.stringify([
      {
        id: "before-update",
        createdAt: 1,
        text: "Original transcript",
        model: "r2t2",
        language: "nl",
        durationMs: 1000,
        processingTimeMs: 100,
        source: "dictation",
      },
    ]),
  );
  if (runtime) {
    for (const name of ["speech-venv", "models"])
      await symlink(join(runtime, name), join(profile, name), "dir");
  }
  for (let launch = 0; launch < 2; launch++) {
    // Simulates the supported manual update: quit, replace .app, relaunch.
    await rm(installed, { recursive: true, force: true });
    execFileSync("ditto", [source, installed]);
    app = await electron.launch({
      executablePath: join(installed, "Contents/MacOS/Delulu Talks"),
      args: [],
      env,
      timeout: 60_000,
    });
    const page = await app.firstWindow();
    await expect
      .poll(
        () =>
          page.evaluate(async () => (await window.delulu.getStatus()).phase),
        { timeout: 90_000 },
      )
      .toBe("idle");
    const state = await page.evaluate(async () => ({
      settings: await window.delulu.getSettings(),
      records: await window.delulu.getHistory(),
      update: await window.delulu.getUpdateStatus(),
      diagnostics: await window.delulu.getDiagnostics(),
    }));
    assert.equal(state.diagnostics.dataDirectory, profile);
    assert.equal(state.settings.model, "qwen3Asr");
    assert.equal(state.settings.language, "nl");
    assert.equal(state.update.phase, "unsupported");
    assert.match(state.update.message, /manual updates/);
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Qwen3-ASR", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("tab", { name: "Capture & delivery", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Language", exact: true }),
    ).toHaveValue("auto");
    await expect(
      page.getByRole("combobox", { name: "Language", exact: true }),
    ).toBeDisabled();
    assert.equal(
      state.records[0].model,
      "r2t2",
      "Preserve the original model attribution in history",
    );
    if (launch === 0) {
      await page.evaluate(async () => {
        await window.delulu.updateSettings({ theme: "dark" });
        await window.delulu.updateTranscript(
          "before-update",
          "Persistent correction",
        );
      });
    } else {
      assert.equal(state.settings.theme, "dark");
      assert.equal(state.records[0].editedText, "Persistent correction");
      if (runtime) {
        await page.evaluate(() => window.delulu.loadModel());
        assert.equal(
          (await page.evaluate(() => window.delulu.getStatus())).engine,
          "ready",
        );
        if (process.env.DELULU_TEST_SCREENSHOT) {
          await page
            .getByRole("button", { name: "Models", exact: true })
            .click();
          await page.screenshot({
            path: process.env.DELULU_TEST_SCREENSHOT,
            fullPage: true,
          });
        }
        await page.evaluate(() => window.delulu.unloadModel());
      }
    }
    await app.close();
    app = null;
  }
  assert.equal(
    JSON.parse(await readFile(join(profile, "history.json"), "utf8"))[0]
      .editedText,
    "Persistent correction",
  );
  console.log(
    "Packaged Mac replacement/relaunch passed: settings, history attribution, corrections, and cached runtime survive; manual update guidance is visible.",
  );
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
