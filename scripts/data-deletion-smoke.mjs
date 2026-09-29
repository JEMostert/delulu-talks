import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rename,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

assert.equal(
  process.platform,
  "linux",
  "This fixture uses a harmless Linux injector; other platforms need their own delivery fixture.",
);

async function verify(operation) {
  const data = await mkdtemp(join(tmpdir(), "delulu-deletion-"));
  const env = {
    ...process.env,
    DELULU_USER_DATA_DIR: data,
    DELULU_SMOKE_TEST: "1",
    HF_HUB_OFFLINE: "1",
    XDG_SESSION_TYPE: "x11",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  let app;
  try {
    // A harmless native injector and captured clipboard writes prevent delivery
    // into another application. Every data/runtime byte belongs to this fixture.
    const bin = join(data, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "xdotool"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "xdotool"), 0o700);
    env.PATH = bin + delimiter + env.PATH;
    const settings = {
      workflowVersion: 1,
      onboardingComplete: true,
      preloadModel: false,
      preloadMagicModel: false,
      autoPaste: false,
      copyToClipboard: false,
      keepHistory: true,
      language: "nl",
    };
    const record = {
      id: "deletion-fixture",
      createdAt: Date.now(),
      text: "Original fixture speech",
      editedText: "Saved fixture correction",
      magicText: "Saved fixture rewrite",
      model: "r2t2",
      source: "dictation",
      language: "nl",
      durationMs: 1000,
      processingTimeMs: 1,
    };
    await writeFile(join(data, "settings.json"), JSON.stringify(settings));
    await writeFile(join(data, "history.json"), JSON.stringify([record]));
    for (const directory of ["speech-venv", "magic-venv", "models"]) {
      await mkdir(join(data, directory));
      await writeFile(join(data, directory, "fixture-sentinel"), directory);
    }
    app = await electron.launch({ args: ["."], env, timeout: 60_000 });
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Controls", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.delulu.getRendererRecoveryState()).canReload,
        ),
      )
      .toBe(true);
    await app.evaluate(({ clipboard }) => {
      globalThis.__deletion = { writes: [], release: null };
      clipboard.writeText = (text) => globalThis.__deletion.writes.push(text);
      const schedule = globalThis.setTimeout;
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 3000) {
          globalThis.__deletion.release = () => callback(...args);
          return { ref() {}, unref() {} };
        }
        return schedule(callback, delay, ...args);
      };
    });
    const before = await readFile(join(data, "settings.json"), "utf8");
    // Updating a persisted record also creates its session-map entry. Clearing
    // must remove both copies; otherwise editing/rewrite IPC resurrects it.
    await page.evaluate(
      (id) => window.delulu.updateTranscript(id, "Session fixture correction"),
      record.id,
    );
    const pendingPaste = page.evaluate(() =>
      window.delulu.pasteLastTranscript().then(
        () => "pasted",
        (error) => error.message,
      ),
    );
    await expect
      .poll(() => app.evaluate(() => !!globalThis.__deletion.release))
      .toBe(true);
    if (operation === "delete") {
      await page.evaluate((id) => window.delulu.deleteHistory(id), record.id);
    } else if (operation === "edit") {
      await page.evaluate(
        (id) => window.delulu.updateTranscript(id, "Newest correction"),
        record.id,
      );
    } else if (operation === "failed-clear") {
      // A directory at the destination makes atomic replacement fail; existing
      // bytes remain in our fixture backup and main must retain both references.
      await rename(
        join(data, "history.json"),
        join(data, "fixture-backup.json"),
      );
      await mkdir(join(data, "history.json"));
      await assert.rejects(page.evaluate(() => window.delulu.clearHistory()));
      assert.equal(
        (await page.evaluate(() => window.delulu.getHistory()))[0].editedText,
        "Session fixture correction",
      );
      assert.equal(
        JSON.parse(await readFile(join(data, "fixture-backup.json"), "utf8"))[0]
          .editedText,
        "Session fixture correction",
      );
      await rm(join(data, "history.json"), { recursive: true });
      await rename(
        join(data, "fixture-backup.json"),
        join(data, "history.json"),
      );
    } else {
      await page.evaluate(() => window.delulu.clearHistory());
    }
    await app.evaluate(() => globalThis.__deletion.release());
    if (["edit", "failed-clear"].includes(operation)) {
      assert.equal(await pendingPaste, "pasted");
      assert.deepEqual(await app.evaluate(() => globalThis.__deletion.writes), [
        operation === "edit"
          ? "Newest correction"
          : "Session fixture correction",
      ]);
      // A deliberate retry remains available after a failed write.
      await page.evaluate(() => window.delulu.clearHistory());
    } else {
      assert.match(await pendingPaste, /removed|deleted|no longer available/i);
      assert.deepEqual(
        await app.evaluate(() => globalThis.__deletion.writes),
        [],
      );
    }
    assert.deepEqual(await page.evaluate(() => window.delulu.getHistory()), []);
    assert.deepEqual(
      JSON.parse(await readFile(join(data, "history.json"), "utf8")),
      [],
    );
    await assert.rejects(
      page.evaluate(
        (id) => window.delulu.updateTranscript(id, "Cannot resurrect"),
        record.id,
      ),
      /Transcript not found/,
    );
    await assert.rejects(
      page.evaluate(
        (id) =>
          window.delulu.setTranscriptRewrite(
            id,
            null,
            "Session fixture correction",
          ),
        record.id,
      ),
      /Transcript not found/,
    );
    await assert.rejects(
      page.evaluate(() => window.delulu.pasteLastTranscript()),
      /Record something first/,
    );
    assert.equal(await readFile(join(data, "settings.json"), "utf8"), before);
    for (const directory of ["speech-venv", "magic-venv", "models"])
      assert.equal(
        await readFile(join(data, directory, "fixture-sentinel"), "utf8"),
        directory,
      );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Controls", exact: true }),
    ).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.delulu.getHistory()), []);
    // Runtime reset explicitly removes the two Python environments, while model
    // cache, settings and transcript state remain outside that operation.
    await page.evaluate(() => window.delulu.resetPythonEnvironment());
    await assert.rejects(
      readFile(join(data, "speech-venv", "fixture-sentinel")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(join(data, "magic-venv", "fixture-sentinel")),
      {
        code: "ENOENT",
      },
    );
    assert.equal(
      await readFile(join(data, "models", "fixture-sentinel"), "utf8"),
      "models",
    );
    assert.equal(await readFile(join(data, "settings.json"), "utf8"), before);
    console.log(
      `${operation}: real isolated Electron deletion/reset fixture passed; clipboard and native injector captured, no inference or personal data.`,
    );
  } finally {
    await app?.close();
    await rm(data, { recursive: true, force: true });
  }
}
for (const operation of ["clear", "delete", "edit", "failed-clear"])
  await verify(operation);
