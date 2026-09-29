import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real Electron/preload/main IPC and native shortcut registration. Use an
// isolated profile; never start or modify a model runtime.
const data = await mkdtemp(join(tmpdir(), "delulu-settings-write-smoke-"));
const env = {
  ...process.env,
  DELULU_USER_DATA_DIR: data,
  DELULU_SMOKE_TEST: "1",
  XDG_SESSION_TYPE: "x11",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({
      preloadModel: false,
      preloadMagicModel: false,
      magicEnabled: false,
      autoPaste: false,
      copyToClipboard: false,
      showOverlay: false,
    }),
  );
  await writeFile(join(data, "history.json"), "[]");
  app = await electron.launch({ args: ["."], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.delulu);
  const previous = "Control+Alt+F7",
    next = "Control+Alt+F8";
  await page.evaluate(
    (shortcut) => window.delulu.updateSettings({ shortcut }),
    previous,
  );
  await page.evaluate(() => {
    window.persistenceEvents = { shortcut: [], settings: [] };
    window.delulu.onShortcutStatus((status) =>
      window.persistenceEvents.shortcut.push(status),
    );
    window.delulu.onSettingsChanged((settings) =>
      window.persistenceEvents.settings.push(settings),
    );
  });
  const file = join(data, "settings.json");
  const bytes = await readFile(file, "utf8");
  await mkdir(file + ".tmp");
  const rejected = await page.evaluate(async (shortcut) => {
    try {
      await window.delulu.updateSettings({ shortcut });
      return false;
    } catch {
      return true;
    }
  }, next);
  assert.equal(rejected, true);
  assert.equal(await readFile(file, "utf8"), bytes);
  const state = await page.evaluate(async () => ({
    settings: await window.delulu.getSettings(),
    shortcut: await window.delulu.getShortcutStatus(),
    events: window.persistenceEvents,
  }));
  assert.equal(state.settings.shortcut, previous);
  assert.equal(state.shortcut.accelerator, previous);
  assert.equal(state.shortcut.registered, true);
  assert.equal(state.events.settings.length, 0);
  assert.ok(
    !state.events.shortcut.some(
      (status) => status.accelerator === next && status.registered,
    ),
  );
  assert.deepEqual(
    await app.evaluate(
      ({ globalShortcut }, keys) =>
        keys.map((key) => globalShortcut.isRegistered(key)),
      [previous, next],
    ),
    [true, false],
  );
  await rm(file + ".tmp", { recursive: true });
  await page.evaluate(
    (shortcut) => window.delulu.updateSettings({ shortcut }),
    next,
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).shortcut, next);
  assert.deepEqual(
    await app.evaluate(
      ({ globalShortcut }, keys) =>
        keys.map((key) => globalShortcut.isRegistered(key)),
      [previous, next],
    ),
    [false, true],
  );
  const events = await page.evaluate(() => window.persistenceEvents);
  assert.equal(events.settings.length, 1);
  assert.equal(events.settings[0].shortcut, next);
  assert.equal(
    events.shortcut.filter(
      (status) => status.accelerator === next && status.registered,
    ).length,
    1,
  );
  console.log(
    "Isolated Electron settings write rejection/shortcut rollback and retry passed (native registration; no inference).",
  );
} finally {
  await app?.close();
  await rm(data, { recursive: true, force: true });
}
