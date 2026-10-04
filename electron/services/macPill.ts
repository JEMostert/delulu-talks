import { BrowserWindow, screen } from "electron";
import type { PillCommand } from "./pill";

const WIDTH = 240;
const HEIGHT = 56;
const BARS = Array.from(
  { length: 9 },
  (_, index) =>
    `<i style="--env:${Math.sin((Math.PI * (index + 0.5)) / 9).toFixed(2)};animation-delay:-${(index * 0.11).toFixed(2)}s"></i>`,
).join("");
// A tiny Deep Sea pill: a pearl and wave bars; words only for results/problems.
const HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:600 12.5px -apple-system,BlinkMacSystemFont,sans-serif;color:#eaf6ff;user-select:none}
body{display:flex;align-items:center;justify-content:center;--accent:#75e4ff;--level:0}
.pill{display:flex;align-items:center;gap:10px;height:40px;padding:0 14px 0 9px;border-radius:20px;background:#06192bf2;border:1px solid #bee8ff38;box-shadow:inset 0 1px #bee8ff24,0 6px 18px #00081455}
.pearl{position:relative;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#fff 0 12%,#f3eee8 40%,#c4ced9 100%);box-shadow:inset 0 -3px 5px color-mix(in srgb,var(--accent) 45%,transparent),0 0 calc(6px + 10px*var(--level)) color-mix(in srgb,var(--accent) 60%,transparent);transition:box-shadow .12s}
.pearl::after{content:"";position:absolute;inset:0;border-radius:50%;background:linear-gradient(135deg,#ffa8c738,#9ee0ff2e,#bca8ff33)}
.bars{display:flex;align-items:center;gap:3px;height:24px}
.bars i{display:block;width:3px;border-radius:2px;height:calc(3px + 19px*var(--env)*(0.2 + 0.8*var(--level)));background:linear-gradient(var(--accent),#75e4ffcc);animation:wave .8s ease-in-out infinite alternate;transition:height .1s}
@keyframes wave{from{transform:scaleY(.45)}to{transform:scaleY(1)}}
.label:empty,.bars[hidden]{display:none}
@media (prefers-reduced-motion:reduce){.bars i{animation:none}}
</style></head><body><div class="pill" role="status"><div class="pearl"></div><div class="bars">${BARS}</div><div class="label" id="label"></div></div></body></html>`;

const ACCENTS: Record<PillCommand["state"], string> = {
  hidden: "#75e4ff",
  listening: "#ff6f86",
  transcribing: "#75e4ff",
  magic: "#75e4ff",
  delivering: "#75e4ff",
  success: "#5fdcbf",
  error: "#f6c979",
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
      Math.round(area.y + area.height - HEIGHT - 16),
      false,
    );
    const level = Number.isFinite(command.level)
      ? Math.min(1, Math.max(0, command.level!))
      : 0;
    const paused = (command.title ?? "").toLowerCase() === "paused";
    const payload = JSON.stringify({
      accent: paused ? "#c2aedb" : ACCENTS[command.state],
      level: command.state === "listening" ? level : 0.35,
      bars:
        !paused &&
        ["listening", "transcribing", "magic", "delivering"].includes(
          command.state,
        ),
      label:
        command.state === "success" || command.state === "error"
          ? (
              command.title ??
              (command.state === "success" ? "Done" : "Needs attention")
            ).slice(0, 28)
          : paused
            ? "Paused"
            : "",
    });
    void window.webContents
      .executeJavaScript(
        `(() => {
      const data = ${payload};
      document.body.style.setProperty('--accent', data.accent);
      document.body.style.setProperty('--level', String(data.level));
      document.querySelector('.bars').hidden = !data.bars;
      document.getElementById('label').textContent = data.label;
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
