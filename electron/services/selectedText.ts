import { clipboard } from "electron";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SelectedTextSession } from "../../src/selectedText";

const TEXT_FORMATS = new Set(["text/plain","text/plain;charset=utf-8","UTF8_STRING","STRING","TEXT"]);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve,ms));
const run = (...args: string[]) => new Promise<string>((resolve,reject) => {
  execFile("xdotool",args,{timeout:2000,maxBuffer:16_384},(error,stdout) => error ? reject(error) : resolve(stdout.trim()));
});
type Destination = { window: string; pid: string };
const EDITORS = new Set(["code","code-insiders","codium","kate","kwrite","gedit","xed","mousepad","leafpad","geany","pluma","sublime_text"]);
/** X11 only. Unsupported desktops do not substitute existing clipboard contents. */
export class SelectedTextService {
  readonly supported = process.platform === "linux" && process.env.XDG_SESSION_TYPE?.toLowerCase() === "x11";
  private pending: { session: SelectedTextSession; destination: Destination } | null = null;
  private busy = false;
  private generation = 0;
  constructor(private readonly available: () => boolean, private readonly lease: <T>(body: () => Promise<T>) => Promise<T>) {}
  get session(): SelectedTextSession | null { return this.pending?.session ?? null; }
  discard(id?: string): void {
    if (!id || this.pending?.session.id === id) { this.generation += 1; this.pending = null; }
  }
  private async destination(): Promise<Destination> {
    const window = await run("getactivewindow");
    if (!/^\d+$/.test(window)) throw new Error("Focused window identity was not reported.");
    const pid = await run("getwindowpid",window);
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) throw new Error("Select text in another application first.");
    const executable = readFileSync(`/proc/${pid}/comm`,"utf8").trim();
    if (!EDITORS.has(executable)) throw new Error("This native workflow accepts supported text editors only; terminal and unknown applications use manual copy. Capture in VS Code, Kate, Gedit or another listed editor.");
    return {window,pid};
  }
  private async verify(destination: Destination): Promise<void> {
    const current = await this.destination();
    if (current.window !== destination.window || current.pid !== destination.pid)
      throw new Error("Destination focus changed. Copy the preview and paste manually, or capture the selection again.");
  }
  private previousClipboard(): string {
    if (clipboard.availableFormats().some((format) => !TEXT_FORMATS.has(format)))
      throw new Error("The clipboard contains rich content that this selection workflow cannot safely restore. Preserve it and capture again with a plain-text clipboard.");
    const text = clipboard.readText();
    if (Buffer.byteLength(text,"utf8") > 1_048_576) throw new Error("Clipboard is too large to preserve safely.");
    return text;
  }
  private clipboardFingerprint(): string {
    return JSON.stringify(clipboard.availableFormats().sort().map((format) => [format,clipboard.readBuffer(format).toString("base64")]));
  }
  private async copySelection(destination: Destination, epoch: number): Promise<string> {
    const previous = this.previousClipboard();
    const marker = `delulu-selection-${randomUUID()}`;
    clipboard.writeText(marker);
    let owned = this.clipboardFingerprint();
    try {
      await this.verify(destination);
      if (epoch !== this.generation) throw new Error("Selection capture cancelled.");
      await run("key","--clearmodifiers","ctrl+c");
      const deadline = Date.now()+1500;
      while (Date.now()<deadline) {
        await wait(40);
        await this.verify(destination);
        if (epoch !== this.generation) throw new Error("Selection capture cancelled.");
        const text = clipboard.readText();
        if (text !== marker) {
          owned = this.clipboardFingerprint();
          if (!text.trim() || text.length>50_000) throw new Error("Select nonempty text of at most 50,000 characters.");
          return text;
        }
      }
      throw new Error("The application did not copy a selection. Nothing was captured.");
    } finally {
      // A clipboard changed by the user or another operation is left intact.
      if (this.clipboardFingerprint() === owned) clipboard.writeText(previous);
    }
  }
  private async operation<T>(body: (epoch: number) => Promise<T>): Promise<T> {
    if (!this.supported) throw new Error("Native selected-text capture is currently supported on X11 only. Use an explicit editor selection or manually entered source on this desktop.");
    if (this.busy || !this.available()) throw new Error("Finish the current capture, rewrite or clipboard delivery first.");
    this.busy = true;
    const epoch = ++this.generation;
    try { return await this.lease(() => body(epoch)); } finally { this.busy = false; }
  }
  async capture(): Promise<SelectedTextSession> {
    return this.operation(async (epoch) => {
      this.pending = null;
      const destination = await this.destination();
      const text = await this.copySelection(destination,epoch);
      await this.verify(destination);
      const session = {id:randomUUID(),text,destination:`X11 window ${destination.window}`,capturedAt:Date.now()};
      if (epoch !== this.generation) throw new Error("Selection capture cancelled.");
      this.pending = {session,destination};
      return session;
    });
  }
  async replace(id: string, text: string): Promise<void> {
    await this.operation(async (epoch) => {
      const pending = this.pending;
      if (!pending || pending.session.id !== id) throw new Error("Selection session expired. Capture it again.");
      if (!text.trim() || text.length>50_000) throw new Error("Preview must contain at most 50,000 characters of nonempty text.");
      // User explicitly confirms replacement after comparing original and preview.
      await run("windowactivate","--sync",pending.destination.window);
      await this.verify(pending.destination);
      if (await this.copySelection(pending.destination,epoch) !== pending.session.text)
        throw new Error("Selected text changed after the preview. Nothing was replaced; capture it again or copy manually.");
      const previous = this.previousClipboard();
      clipboard.writeText(text);
      const owned = this.clipboardFingerprint();
      try {
        await this.verify(pending.destination);
        if (epoch !== this.generation) throw new Error("Selection replacement cancelled.");
        await run("key","--clearmodifiers","ctrl+v");
        this.pending = null;
        await wait(2000);
      } finally {
        if (this.clipboardFingerprint() === owned) clipboard.writeText(previous);
      }
      // Keyboard injection is an attempt, not confirmation that the editor accepted it.
    });
  }
}
