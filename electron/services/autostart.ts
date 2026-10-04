import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FILE = "delulu-talks.desktop";

/** XDG autostart entry for Linux, where Electron has no login-item API. */
export function linuxAutostartPath(env: NodeJS.ProcessEnv = process.env) {
  const config = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(config, "autostart", FILE);
}

function quote(path: string): string {
  return /[\s"'\\$`]/.test(path)
    ? `"${path.replace(/(["\\$`])/g, "\\$1")}"`
    : path;
}

export function linuxAutostartEntry(executable: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Delulu Talks",
    "Comment=Private local dictation",
    `Exec=${quote(executable)} --hidden`,
    "Icon=delulu-talks",
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Writes or removes the entry; an AppImage starts from its stable image path. */
export function setLinuxAutostart(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
  executable = env.APPIMAGE || process.execPath,
): void {
  const path = linuxAutostartPath(env);
  if (!enabled) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, linuxAutostartEntry(executable), { mode: 0o644 });
}

export function linuxAutostartEnabled(env: NodeJS.ProcessEnv = process.env) {
  return existsSync(linuxAutostartPath(env));
}
