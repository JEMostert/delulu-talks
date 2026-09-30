import { expect, test } from "bun:test";

const mainUrl = new URL("../main.ts", import.meta.url).href;
const storageUrl = new URL("./storage.ts", import.meta.url).href;
const shortcutUrl = new URL("./shortcut.ts", import.meta.url).href;
const portalUrl = new URL("./shortcutPortal.ts", import.meta.url).href;

for (const scenario of [
  "write",
  "busy",
  "registration",
  "restore",
  "restore-throw",
  "portal",
  "late-busy",
]) {
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
        let rejectNew = false, rejectOld = false, throwOld = false, becomeBusy = false;
        let markBusy = () => {};
        let registrations = 0;
        const old = "Control+Alt+F7", next = "Control+Alt+F8";
        mock.module("electron", () => ({
          app: { getPath: () => root, isPackaged: false },
          globalShortcut: {
            unregisterAll: () => bindings.clear(),
            register: (key) => {
              registrations++;
              if (key === old && throwOld) throw new Error("Native restore threw");
              if ((key === next && rejectNew) || (key === old && rejectOld)) return false;
              bindings.add(key); if (key === next && becomeBusy) markBusy(); return true;
            },
          },
        }));
        const scenario = ${JSON.stringify(scenario)};
        const display = (key) => scenario === "portal" ? key.replace("Control", "Strg") : key;
        const preferredTriggers = [];
        if (scenario === "portal") {
          Object.defineProperty(process, "platform", { value: "linux" });
          const dbus = { ...await import("dbus-next") };
          let description = "";
          const transport = {
            on() {},
            async Register() {}, async Close() {},
            async CreateSession() { return "/request/create"; },
            async BindShortcuts(_session, entries) {
              const preferred = entries[0][1].preferred_trigger.value;
              preferredTriggers.push(preferred);
              assert.ok(["CTRL+ALT+f7", "CTRL+ALT+f8"].includes(preferred), "Rollback lost canonical modifiers");
              const key = preferred.endsWith("f7") ? old : next;
              bindings.clear(); bindings.add(key); description = display(key);
              return "/request/bind";
            },
          };
          mock.module("dbus-next", () => ({ ...dbus,
            sessionBus: () => ({ on() {}, disconnect() {}, name: ":1.42",
              async getProxyObject() { return { getInterface: () => transport }; },
            }),
          }));
          mock.module(${JSON.stringify(portalUrl)}, () => ({
            PORTAL_NAME: "org.freedesktop.portal.Desktop", PORTAL_PATH: "/org/freedesktop/portal/desktop",
            async portalRequest(_bus, token, invoke) {
              await invoke(token);
              return token.endsWith("_create")
                ? [0, { session_handle: new dbus.Variant("s", "/session/fixture") }]
                : [0, { shortcuts: [["toggle-dictation", { trigger_description: new dbus.Variant("s", description) }]] }];
            },
          }));
        }
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
          markBusy = () => { asr.isBusy = true; };
          // Execute the actual production coordinator without booting main/app.
          // Service/file writes are real; native shortcut and runtime ports are fixtures.
          const source = readFileSync(fileURLToPath(${JSON.stringify(mainUrl)}), "utf8");
          const start = source.indexOf("async function applySettings(");
          const end = source.indexOf("function assertRuntimeIdle()", start);
          assert.ok(start >= 0 && end > start);
          const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
          const apply = new Function("storage", "shortcut", "normalizeSettings", "dictation", "asr", "smokeTest", "app", "pill", "broadcast", "rebuildTrayMenu", "assertPersonalProfilesUpdate", compiled + "; return applySettings;")(
            storage, shortcut, normalizeSettings, dictation, asr, true, { isPackaged: false }, { prepare() {} },
            (name, settings) => settingsEvents.push({ name, settings }), () => {},
            (await import(${JSON.stringify(new URL("../../src/personalProfiles.ts", import.meta.url).href)})).assertPersonalProfilesUpdate,
          );
          const writeSettings = storage.updateSettings.bind(storage);
          let rejectWrite = ["write", "restore", "restore-throw", "portal"].includes(scenario);
          storage.updateSettings = (next) => { if (rejectWrite) throw new Error("Fixture atomic write rejected"); return writeSettings(next); };
          const path = join(root, "settings.json");
          const bytes = readFileSync(path, "utf8"), before = storage.getSettings();
          if (["write", "restore", "restore-throw", "portal"].includes(scenario)) mkdirSync(path + ".tmp");
          if (scenario === "busy") asr.isBusy = true;
          if (scenario === "late-busy") becomeBusy = true;
          if (scenario === "registration") rejectNew = true;
          if (scenario === "restore") rejectOld = true;
          if (scenario === "restore-throw") throwOld = true;
          await assert.rejects(apply({ shortcut: next, ...(["busy", "late-busy"].includes(scenario) ? { magicEnabled: true } : {}) }),
            ["busy", "late-busy"].includes(scenario) ? /Finish the current/ : scenario.startsWith("restore") ? /could not be restored/ : undefined);
          assert.equal(readFileSync(path, "utf8"), bytes);
          assert.deepEqual(storage.getSettings(), before);
          assert.equal(settingsEvents.length, 0);
          assert.ok(!statuses.some(status => status.accelerator === display(next) && status.registered));
          if (scenario === "busy") {
            assert.equal(registrations, 0); assert.equal(statuses.length, 0);
          }
          if (scenario.startsWith("restore")) {
            assert.equal(shortcut.getStatus().registered, false);
            assert.equal(bindings.size, 0);
          } else {
            assert.deepEqual([...bindings], [old]);
            assert.equal(shortcut.getStatus().accelerator, display(old));
            assert.equal(shortcut.getStatus().registered, true);
          }
          // An intentional retry commits disk, memory, binding and final events.
          rmSync(path + ".tmp", { recursive: true, force: true });
          rejectWrite = false; rejectNew = rejectOld = throwOld = becomeBusy = false; asr.isBusy = false;
          statuses.length = 0;
          const saved = await apply({ shortcut: next });
          assert.equal(saved.shortcut, next);
          assert.equal(JSON.parse(readFileSync(path, "utf8")).shortcut, next);
          assert.deepEqual([...bindings], [next]);
          assert.equal(statuses.length, 1);
          assert.equal(statuses[0].accelerator, display(next));
          assert.equal(statuses[0].registered, true);
          assert.equal(settingsEvents.length, 1);
          if (scenario === "portal") assert.deepEqual(preferredTriggers, ["CTRL+ALT+f7", "CTRL+ALT+f8", "CTRL+ALT+f7", "CTRL+ALT+f8"]);
          process.stdout.write("verified");
        } finally { rmSync(root, { recursive: true, force: true }); }
      `,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          XDG_SESSION_TYPE: scenario === "portal" ? "wayland" : "x11",
        },
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
