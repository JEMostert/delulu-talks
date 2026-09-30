import { BrowserWindow, screen } from "electron";
import type { PillCommand } from "./pill";

const WIDTH = 320;
const HEIGHT = 72;
const HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;background:transparent;overflow:hidden;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#eff8ff;user-select:none}
.pill{margin:4px;padding:12px 16px;border:1px solid #577896;border-radius:24px;background:#102a43;box-shadow:0 2px 8px #0006}
#title{font-weight:650;font-size:14px}#detail{font-size:11px;color:#c9ddeb;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track{position:absolute;right:20px;top:23px;width:44px;height:7px;border-radius:4px;background:#35536e}
#level{height:100%;width:0;background:#65c5ff;border-radius:4px}
</style></head><body><div class="pill" role="status"><div id="title">Listening</div><div id="detail">Recording locally</div><div class="track"><div id="level"></div></div></div></body></html>`;

const TITLES: Record<PillCommand["state"], string> = {
  hidden: "",
  listening: "● Listening",
  transcribing: "Transcribing",
  magic: "Rewriting",
  delivering: "Delivering",
  success: "Done",
  error: "Needs attention",
};

/** A nonactivating, click-through panel; it never hosts transcript content. */
export class MacPill {
  private window: BrowserWindow | null = null;
  private ready = false;
  private desired: PillCommand = { state: "hidden" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;

  constructor(private readonly onError: (message: string) => void) {}

  send(command: PillCommand): void {
    this.desired = command;
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (command.state === "hidden") {
      this.window?.hide();
      return;
    }
    if (!this.window) this.create();
    if (this.ready) this.render();
    if (command.state === "success" || command.state === "error") {
      this.timer = setTimeout(() => this.send({ state: "hidden" }), 2500);
      this.timer.unref();
    }
  }

  private create(): void {
    try {
      const window = new BrowserWindow({
        width: WIDTH,
        height: HEIGHT,
        show: false,
        frame: false,
        transparent: true,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        type: "panel",
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      this.window = window;
      window.setIgnoreMouseEvents(true);
      window.setAlwaysOnTop(true, "floating");
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      window.setHiddenInMissionControl(true);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.once("closed", () => {
        if (this.window === window) {
          this.window = null;
          this.ready = false;
        }
      });
      void window
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`)
        .then(() => {
          if (this.window !== window) return;
          this.ready = true;
          this.render();
        })
        .catch((error: unknown) => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }

  private render(): void {
    const window = this.window;
    if (!window || window.isDestroyed() || this.desired.state === "hidden")
      return;
    const command = this.desired;
    const revision = this.revision;
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const area = display.workArea;
    window.setPosition(
      Math.round(area.x + (area.width - WIDTH) / 2),
      Math.round(area.y + area.height - HEIGHT - 20),
      false,
    );
    const level = Number.isFinite(command.level)
      ? Math.min(1, Math.max(0, command.level!))
      : 0;
    const payload = JSON.stringify({
      title: command.title || TITLES[command.state],
      detail:
        command.detail ||
        (command.state === "listening" ? "Recording locally" : ""),
      level: command.state === "listening" ? level * 100 : 0,
    });
    void window.webContents
      .executeJavaScript(
        `(() => {
      const data = ${payload};
      document.getElementById('title').textContent = data.title;
      document.getElementById('detail').textContent = data.detail;
      document.getElementById('level').style.width = data.level + '%';
    })()`,
      )
      .then(() => {
        if (
          this.window === window &&
          this.revision === revision &&
          !window.isDestroyed()
        )
          window.showInactive();
      })
      .catch((error: unknown) => this.fail(error));
  }

  private fail(error: unknown): void {
    this.onError(
      `Mac recording indicator unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    this.shutdown();
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const window = this.window;
    this.window = null;
    this.ready = false;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
