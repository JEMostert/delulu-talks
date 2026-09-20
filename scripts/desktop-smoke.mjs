import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const data = await mkdtemp(join(tmpdir(), "delulu-desktop-smoke-"));
const env = {
  ...process.env,
  DELULU_USER_DATA_DIR: data,
  DELULU_SMOKE_TEST: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
const runtimeData = process.argv[2];
if (runtimeData) {
  env.HF_HUB_OFFLINE = "1";
}
let app;
try {
  // Explicit empty files prevent legacy migration from reading real user data.
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({ magicEnabled: true, preloadMagicModel: true }),
  );
  await writeFile(join(data, "history.json"), "[]");
  if (runtimeData) {
    await symlink(
      join(runtimeData, "speech-venv"),
      join(data, "speech-venv"),
      "dir",
    );
    if (process.argv.includes("--writing"))
      await symlink(
        join(runtimeData, "asr-venv"),
        join(data, "asr-venv"),
        "dir",
      );
    await symlink(join(runtimeData, "models"), join(data, "models"), "dir");
    await writeFile(
      join(data, "settings.json"),
      JSON.stringify({
        preloadModel: false,
        preloadMagicModel: false,
        magicEnabled: false,
        autoPaste: false,
        copyToClipboard: false,
        keepHistory: false,
        showOverlay: false,
      }),
    );
  }
  app = await electron.launch({ args: ["."], env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Dismiss setup" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Application", exact: true }).click();
  await page.getByRole("button", { name: "dark", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  if (runtimeData)
    await expect
      .poll(
        () =>
          page.evaluate(async () => (await window.delulu.getStatus()).phase),
        { timeout: 30_000 },
      )
      .toBe("idle");
  const state = await page.evaluate(async () => ({
    settings: await window.delulu.getSettings(),
    diagnostics: await window.delulu.getDiagnostics(),
    status: await window.delulu.getStatus(),
  }));
  assert.equal(
    state.settings.magicEnabled,
    false,
    "Older default-on rewriting must migrate to opt-in",
  );
  assert.equal(state.settings.preloadMagicModel, false);
  assert.equal(state.settings.workflowVersion, 1);
  assert.equal(state.settings.theme, "dark");
  assert.equal(state.settings.onboardingComplete, true);
  assert.equal(state.status.engine, runtimeData ? "unloaded" : "missing");
  assert.equal(state.diagnostics.dataDirectory, data);
  if (!runtimeData) {
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Install engine", exact: true }),
    ).toBeVisible();
  } else {
    const audioPath = join(data, "sample.wav");
    execFileSync("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      "test-audio.m4a",
      "-ac",
      "1",
      "-ar",
      "16000",
      audioPath,
    ]);
    const audio = Array.from(await readFile(audioPath));
    await page.evaluate(async (wav) => {
      await window.delulu.loadModel();
      await window.delulu.submitRecording({
        wav: new Uint8Array(wav),
        durationMs: 4573,
      });
    }, audio);
    const records = await page.evaluate(() => window.delulu.getHistory());
    assert.equal(
      records.length,
      1,
      "Session history should include the actual inference result",
    );
    assert.ok(records[0].text.trim());
    assert.deepEqual(
      JSON.parse(await readFile(join(data, "history.json"), "utf8")),
      [],
    );
    await page.evaluate(
      (id) =>
        window.delulu.updateTranscript(id, "Session correction stays private."),
      records[0].id,
    );
    const exportPath = join(data, "session-export.json");
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportPath);
    await page.evaluate(
      (id) => window.delulu.exportTranscript(id, "json"),
      records[0].id,
    );
    const exported = JSON.parse(await readFile(exportPath, "utf8"));
    assert.equal(exported.editedText, "Session correction stays private.");
    assert.equal(exported.text, records[0].text);
    if (process.argv.includes("--writing")) {
      const rewritten = await page.evaluate(async (id) => {
        await window.delulu.updateSettings({
          customWords: [
            {
              id: "signature",
              kind: "shortcut",
              term: "my signature",
              soundsLike: "",
              replacement: "Best,\nBoran",
              enabled: true,
            },
          ],
        });
        for (const preset of ["concise", "structured", "prompt"]) {
          const check = await window.delulu.rewriteMagic({
            text: "Please move the review to Thursday. my signature",
            preset,
            allowInferences: false,
          });
          if (
            !check.text.includes("Thursday") ||
            !check.text.includes("Best,\nBoran")
          )
            throw new Error(`Rewrite ${preset} lost a fact or shortcut`);
        }
        const result = await window.delulu.rewriteMagic({
          text: "Please move the review to Thursday. my signature",
          preset: "polish",
          allowInferences: false,
        });
        await window.delulu.setTranscriptRewrite(
          id,
          result,
          "Session correction stays private.",
        );
        return result;
      }, records[0].id);
      assert.ok(
        rewritten.text.includes("Thursday"),
        "Rewrite must preserve the day",
      );
      assert.ok(
        rewritten.text.includes("Best,\nBoran"),
        "Text shortcut must be byte-exact",
      );
      await page.evaluate(
        async ({ id, text }) => {
          await window.delulu.setTranscriptRewrite(id, null, text);
        },
        { id: records[0].id, text: rewritten.text },
      );
      const settings = await page.evaluate(() => window.delulu.getSettings());
      assert.equal(
        settings.magicEnabled,
        false,
        "Manual writing must not enable automatic rewriting",
      );
      console.log(
        "Manual writing passed with automatic rewriting off, exact shortcut preservation, apply, and undo.",
      );
    }
    await page.evaluate((id) => window.delulu.deleteHistory(id), records[0].id);
    assert.equal(
      (await page.evaluate(() => window.delulu.getHistory())).length,
      0,
    );
    console.log(
      "Real Electron inference passed: PCM → worker → session history → correction → JSON export → deletion; history saving stayed off.",
    );
  }
  console.log(
    "Desktop smoke passed: sandboxed preload, settings IPC, persistence, diagnostics, setup readiness.",
  );
} finally {
  await app?.close();
  await rm(data, { recursive: true, force: true });
}
