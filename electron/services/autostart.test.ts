import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  linuxAutostartEnabled,
  linuxAutostartPath,
  setLinuxAutostart,
} from "./autostart";

test("Linux autostart writes and removes an XDG entry", () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "delulu-xdg-")) };
  setLinuxAutostart(true, env, "/opt/Delulu Talks/delulu-talks");
  expect(linuxAutostartPath(env)).toBe(
    join(env.XDG_CONFIG_HOME, "autostart", "delulu-talks.desktop"),
  );
  expect(readFileSync(linuxAutostartPath(env), "utf8")).toContain(
    'Exec="/opt/Delulu Talks/delulu-talks" --hidden',
  );
  expect(linuxAutostartEnabled(env)).toBe(true);
  setLinuxAutostart(false, env);
  expect(linuxAutostartEnabled(env)).toBe(false);
});
