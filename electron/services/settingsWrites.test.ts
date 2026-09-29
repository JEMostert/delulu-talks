import { expect, test } from "bun:test";

const mainUrl = new URL("../main.ts", import.meta.url).href;
const storageUrl = new URL("./storage.ts", import.meta.url).href;
const shortcutUrl = new URL("./shortcut.ts", import.meta.url).href;

for (const scenario of ["write", "busy", "registration", "restore"]) {
  test(`settings coordination preserves effective state on ${scenario} rejection`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        import { mock } from "bun:test";
        import assert from "node:assert/strict";
        import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
        import { fileURLToPath } from "node:url";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        const root = mkdtempSync(join(tmpdir(), "delulu-settings-transaction-"));
        const bindings = new Set();
        let rejectNew = false, rejectOld = false;
        let registrations = 0;
        const old = "Control+Alt+F7", next = "Control+Alt+F8";
        mock.module("electron", () => ({
          app: { getPath: () => root, isPackaged: false },
          globalShortcut: {
            unregisterAll: () => bindings.clear(),
            register: (key) => {
              registrations++;
              if ((key === next && rejectNew) || (key === old && rejectOld)) return false;
              bindings.add(key); return true;
            },
          },
        }));
        try {
          const { StorageService, normalizeSettings } = await import(${JSON.stringify(storageUrl)});
          const { ShortcutService } = await import(${JSON.stringify(shortcutUrl)});
          const storage = new StorageService();
          storage.updateSettings({ ...storage.getSettings(), shortcut: old });
          const shortcut = new ShortcutService(() => "toggle", {
            start() {}, stop() {}, toggle() {},
          });
          await shortcut.register(old);
          registrations = 0;
          const statuses = [], settingsEvents = [];
          shortcut.onStatus(status => statuses.push(status));
          const asr = { isBusy: false, unload: async () => {}, unloadMagic: async () => {}, configureResidency() {} };
          const dictation = { isActive: false, syncOverlay() {} };
          // Execute the actual production coordinator without booting main/app.
          // Service/file writes are real; native shortcut and runtime ports are fixtures.
          const source = readFileSync(fileURLToPath(${JSON.stringify(mainUrl)}), "utf8");
          const start = source.indexOf("async function applySettings(");
          const end = source.indexOf("function assertRuntimeIdle()", start);
          assert.ok(start >= 0 && end > start);
          const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
          const apply = new Function("storage", "shortcut", "normalizeSettings", "dictation", "asr", "smokeTest", "app", "pill", "broadcast", "rebuildTrayMenu", compiled + "; return applySettings;")(
            storage, shortcut, normalizeSettings, dictation, asr, true, { isPackaged: false }, { prepare() {} },
            (name, settings) => settingsEvents.push({ name, settings }), () => {},
          );
          const path = join(root, "settings.json");
          const bytes = readFileSync(path, "utf8"), before = storage.getSettings();
          const scenario = ${JSON.stringify(scenario)};
          if (scenario === "write" || scenario === "restore") mkdirSync(path + ".tmp");
          if (scenario === "busy") asr.isBusy = true;
          if (scenario === "registration") rejectNew = true;
          if (scenario === "restore") rejectOld = true;
          await assert.rejects(apply({ shortcut: next, ...(scenario === "busy" ? { magicEnabled: true } : {}) }),
            scenario === "busy" ? /Finish the current/ : scenario === "restore" ? /could not be restored/ : undefined);
          assert.equal(readFileSync(path, "utf8"), bytes);
          assert.deepEqual(storage.getSettings(), before);
          assert.equal(settingsEvents.length, 0);
          assert.ok(!statuses.some(status => status.accelerator === next && status.registered));
          if (scenario === "busy") {
            assert.equal(registrations, 0); assert.equal(statuses.length, 0);
          }
          if (scenario === "restore") {
            assert.equal(shortcut.getStatus().registered, false);
            assert.equal(bindings.size, 0);
          } else {
            assert.deepEqual([...bindings], [old]);
            assert.equal(shortcut.getStatus().accelerator, old);
            assert.equal(shortcut.getStatus().registered, true);
          }
          // An intentional retry commits disk, memory, binding and final events.
          rmSync(path + ".tmp", { recursive: true, force: true });
          rejectNew = rejectOld = false; asr.isBusy = false;
          statuses.length = 0;
          const saved = await apply({ shortcut: next });
          assert.equal(saved.shortcut, next);
          assert.equal(JSON.parse(readFileSync(path, "utf8")).shortcut, next);
          assert.deepEqual([...bindings], [next]);
          assert.equal(statuses.length, 1);
          assert.equal(statuses[0].accelerator, next);
          assert.equal(statuses[0].registered, true);
          assert.equal(settingsEvents.length, 1);
          process.stdout.write("verified");
        } finally { rmSync(root, { recursive: true, force: true }); }
      `,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, XDG_SESSION_TYPE: "x11" },
      },
    );
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, diagnostic).toBe(0);
    expect(output).toBe("verified");
  });
}
