export type ShortcutMode = "hold" | "toggle";
export type ShortcutActions = { start(): void; stop(): void; toggle(): void };

/** Converts press/release signals and activation-only shortcuts into dictation commands. */
export class ShortcutGesture {
  private pressed = false;
  private stopOnRelease = false;

  constructor(private readonly mode: () => ShortcutMode, private readonly actions: ShortcutActions) {}

  press(canRelease: boolean): void {
    if (canRelease) {
      if (this.pressed) return;
      this.pressed = true;
    }
    this.stopOnRelease = canRelease && this.mode() === "hold";
    if (this.stopOnRelease) this.actions.start();
    else this.actions.toggle();
  }

  release(): void {
    if (!this.pressed) return;
    this.pressed = false;
    if (this.stopOnRelease) this.actions.stop();
    this.stopOnRelease = false;
  }

  reset(): void {
    this.pressed = false;
    this.stopOnRelease = false;
  }
}
