import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const data = await mkdtemp(join(tmpdir(), "delulu-desktop-smoke-"));
const env = {
  ...process.env,
  DELULU_USER_DATA_DIR: data,
  DELULU_SMOKE_TEST: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
const runtimeData = process.argv[2] ? resolve(process.argv[2]) : undefined;
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
  const packagedExecutable = process.env.DELULU_TEST_EXECUTABLE;
  app = await electron.launch({
    args: packagedExecutable ? [] : ["."],
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    env,
    timeout: 60_000,
  });
  assert.equal(
    await app.evaluate(({ app }) => app.getName()),
    packagedExecutable ? "Delulu Talks" : "Delulu Talks Dev",
  );
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Dismiss setup" }).click();
  const workletAsset = await app.evaluate(({ app }) => {
    const { readdirSync } = process.getBuiltinModule("node:fs");
    const { join } = process.getBuiltinModule("node:path");
    return readdirSync(join(app.getAppPath(), "out/renderer/assets")).find(
      (name) => /^captureWorklet-.*\.js$/.test(name),
    );
  });
  assert.ok(workletAsset, "The built capture worklet must be packaged");
  // Verify the built file:// asset with the production CSP and real Web Audio.
  // Oscillator input requires neither microphone permission nor a speech model.
  const workletCapture = await page.evaluate(async (asset) => {
    const context = new AudioContext({ sampleRate: 16_000 });
    let timer;
    try {
      await context.audioWorklet.addModule(
        new URL(`assets/${asset}`, document.baseURI).href,
      );
      const worklet = new AudioWorkletNode(context, "delulu-capture");
      const source = context.createOscillator();
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(worklet).connect(sink).connect(context.destination);
      let samples = 0;
      let first;
      let flushed;
      const firstBatch = new Promise((resolve) => {
        first = resolve;
      });
      const flush = new Promise((resolve) => {
        flushed = resolve;
      });
      worklet.port.onmessage = (event) => {
        if (event.data.samples) {
          samples += event.data.samples.length;
          first();
        }
        if (event.data.flushed) flushed();
      };
      const captured = (async () => {
        source.start();
        await context.resume();
        await firstBatch;
        source.disconnect();
        worklet.port.postMessage("flush");
        await flush;
        source.stop();
        return { samples, flushed: true };
      })();
      return await Promise.race([
        captured,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Built worklet capture timed out")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await context.close();
    }
  }, workletAsset);
  assert.ok(workletCapture.samples > 0);
  assert.equal(workletCapture.flushed, true);
  console.log(
    "Built worklet passed: file:// asset, production CSP, synthetic Web Audio capture and flush; no microphone or inference.",
  );
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
  const metal =
    state.diagnostics.platform === "darwin" &&
    state.diagnostics.arch === "arm64";
  assert.equal(state.settings.model, metal ? "r2t2Mlx" : "r2t2");
  assert.equal(state.status.speechModel, state.settings.model);
  if (metal) {
    const update = await page.evaluate(() => window.delulu.getUpdateStatus());
    assert.equal(update.phase, "unsupported");
    assert.match(update.message, /unsigned Mac build uses manual updates/);
  }
  if (!runtimeData) {
    // Exercise the real sandboxed preload/main boundary: abandoned callbacks
    // must not change idle state or create transcript/cache data.
    const abandoned = await page.evaluate(async () => {
      const before = await window.delulu.getStatus();
      await window.delulu.recordingStarted("abandoned-capture");
      await window.delulu.recordingFailed(
        "An abandoned microphone failed",
        "abandoned-capture",
      );
      await window.delulu.submitRecording({
        sessionId: "abandoned-capture",
        wav: new Uint8Array(44),
        durationMs: 1000,
      });
      return {
        before,
        after: await window.delulu.getStatus(),
        history: await window.delulu.getHistory(),
      };
    });
    assert.deepEqual(abandoned.after, abandoned.before);
    assert.deepEqual(abandoned.history, []);
    console.log(
      "Abandoned capture IPC passed: late started/failed/audio callbacks leave idle state and history unchanged; no microphone or inference.",
    );
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Install engine", exact: true }),
    ).toBeVisible();
  } else {
    const audioPath = join(data, "sample.wav");
    if (process.platform === "darwin") {
      execFileSync("afconvert", [
        "test-audio.m4a",
        audioPath,
        "-f",
        "WAVE",
        "-d",
        "LEI16@16000",
        "-c",
        "1",
      ]);
    } else {
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
    }
    // Native inference consumes the explicit file fixture through the import API.
    // Recorder submissions belong exclusively to their live capture session.
    await page.evaluate(async (path) => {
      await window.delulu.loadModel();
      await window.delulu.runLab({ path });
    }, audioPath);
    const records = await page.evaluate(() => window.delulu.getHistory());
    assert.equal(records[0]?.source, "file");
    if (process.env.DELULU_EVIDENCE_NATIVE_RESULT) {
      await writeFile(
        process.env.DELULU_EVIDENCE_NATIVE_RESULT,
        JSON.stringify({
          model: records[0]?.model,
          modelSource: "application transcript attribution",
          backend: metal
            ? "mlx"
            : process.platform === "win32"
              ? "cuda-transformers"
              : "cuda-vllm",
          backendSource:
            "Electron platform selection and returned transcript model",
          fixtureSha256: createHash("sha256")
            .update(await readFile("test-audio.m4a"))
            .digest("hex"),
          characters: records[0]?.text.length ?? 0,
        }),
      );
    }
    if (process.argv.includes("--lifecycle")) {
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.evaluate(async (path) => {
          await window.delulu.unloadModel();
          if ((await window.delulu.getStatus()).engine !== "unloaded")
            throw new Error("Speech did not unload");
          await window.delulu.loadModel();
          await window.delulu.runLab({ path });
        }, audioPath);
      }
      const cycles = await page.evaluate(() => window.delulu.getHistory());
      assert.equal(cycles.length, 4);
      for (const record of cycles.slice(0, -1))
        await page.evaluate((id) => window.delulu.deleteHistory(id), record.id);
      console.log("Three real speech unload/reload/transcribe cycles passed.");
    }
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
      await page.evaluate(() => window.delulu.unloadModel());
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
          (await window.delulu.getHistory()).find((item) => item.id === id)?.sourceRevision ?? 0,
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
          await window.delulu.setTranscriptRewrite(
            id, null, text,
            (await window.delulu.getHistory()).find((item) => item.id === id)?.sourceRevision ?? 0,
          );
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
      await page.evaluate(async () => {
        await window.delulu.unloadMagic();
        await window.delulu.loadModel();
        await window.delulu.unloadModel();
      });
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
