import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Invented fixtures through real Electron/preload/IPC/storage and React copy.
// Writing outputs are supplied fixtures; no model or real destination is used.
const profile = await mkdtemp(join(tmpdir(), "delulu-exact-blocks-"));
const block =
  "\n  curl https://api.example/Café --header X-ID\r\n\t# Keep 🚀\r\n";
const rule = {
  id: "exact-command",
  kind: "shortcut",
  term: "second snippet",
  soundsLike: "",
  replacement: block,
  enabled: true,
};
const env = {
  ...process.env,
  DELULU_USER_DATA_DIR: profile,
  DELULU_SMOKE_TEST: "1",
  HF_HUB_OFFLINE: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let app;
try {
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({
      workflowVersion: 1,
      onboardingComplete: true,
      preloadModel: false,
      preloadMagicModel: false,
      magicEnabled: false,
      autoPaste: false,
      copyToClipboard: false,
      keepHistory: true,
      showOverlay: false,
      customWords: [rule],
    }),
  );
  await writeFile(
    join(profile, "history.json"),
    JSON.stringify([
      {
        id: "exact-source",
        createdAt: 1,
        text: "second snippet",
        personalizedText: block,
        model: "r2t2",
        language: "en",
        source: "dictation",
        durationMs: 1,
        processingTimeMs: 1,
      },
    ]),
  );
  for (let launch = 0; launch < 2; launch++) {
    app = await electron.launch({ args: ["."], env, timeout: 60_000 });
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Controls", exact: true }),
    ).toBeVisible();
    await app.evaluate(({ clipboard }) => {
      globalThis.__exactBlockCopies = [];
      clipboard.writeText = (text) => globalThis.__exactBlockCopies.push(text);
    });
    const settings = await page.evaluate(() => window.delulu.getSettings());
    assert.equal(settings.customWords[0].replacement, block);
    const initial = (await page.evaluate(() => window.delulu.getHistory()))[0];
    assert.equal(initial.text, "second snippet");
    assert.equal(initial.personalizedText, block);
    if (launch === 1) assert.equal(initial.magicText, block);
    for (const preset of ["polish", "concise", "structured", "prompt"]) {
      const result = await page.evaluate(
        async ({ block, preset }) => {
          const result = {
            text: block,
            preset,
            model: "qwen35Medium",
            processingTimeMs: 1,
            includedInferences: false,
          };
          return window.delulu.setTranscriptRewrite(
            "exact-source",
            result,
            block,
          );
        },
        { block, preset },
      );
      assert.equal(result.magicText, block);
      assert.equal(result.text, "second snippet");
    }
    const emptyError = await page.evaluate(async (block) => {
      try {
        await window.delulu.setTranscriptRewrite(
          "exact-source",
          { text: " \n\t", preset: "polish", model: "qwen35Medium" },
          block,
        );
        return "accepted empty rewrite";
      } catch (error) {
        return error.message;
      }
    }, block);
    assert.match(emptyError, /A rewrite cannot be empty/);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "History", exact: true })
      .click();
    await page
      .locator(".transcript-card:not(.inspector-card)")
      .getByRole("button", { name: "Copy delivered text", exact: true })
      .click();
    await expect
      .poll(() => app.evaluate(() => globalThis.__exactBlockCopies.at(-1)))
      .toBe(block);
    const exported = join(profile, `exact-${launch}.txt`);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exported);
    await page.evaluate(() =>
      window.delulu.exportTranscript("exact-source", "txt"),
    );
    assert.equal(
      await readFile(exported, "utf8"),
      `${block}\n\n--- Source transcript ---\n\nsecond snippet\n`,
    );
    await app.close();
    app = null;
    const stored = JSON.parse(
      await readFile(join(profile, "history.json"), "utf8"),
    )[0];
    assert.equal(stored.magicText, block);
    assert.equal(stored.personalizedText, block);
  }
  console.log(
    "Exact blocks survived fixture apply, React copy, export and profile reopen; no native inference or real clipboard delivery.",
  );
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}
