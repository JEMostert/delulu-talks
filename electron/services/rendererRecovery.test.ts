import { describe, expect, test } from "bun:test";
import { SerialQueue } from "../runtime/serialQueue";
import {
  reloadRenderer,
  rendererRecoveryState,
  type RecoveryInput,
} from "./rendererRecovery";

const idle: RecoveryInput = {
  captureActive: false,
  canStopRecording: false,
  runtimeBusy: false,
  settingsBusy: false,
  updateBusy: false,
};

describe("renderer recovery", () => {
  test.each([
    ["opening microphone", true],
    ["listening", true],
    ["stopping capture", false],
    ["processing submitted audio", false],
  ])("does not reload while %s", (_phase, canStopRecording) => {
    const input = { ...idle, captureActive: true, canStopRecording };
    const state = rendererRecoveryState(input);
    expect(state.canReload).toBe(false);
    expect(state.reason).toContain("capture or transcription");
    expect(state.canStopRecording).toBe(canStopRecording);
    let reloads = 0;
    expect(() => reloadRenderer(input, () => reloads++)).toThrow(state.reason!);
    expect(reloads).toBe(0);
  });

  test.each(["initialization", "setup", "inference", "rewrite"])(
    "does not reload during runtime %s",
    () => {
      let reloads = 0;
      const input = { ...idle, runtimeBusy: true };
      expect(rendererRecoveryState(input).canReload).toBe(false);
      expect(() => reloadRenderer(input, () => reloads++)).toThrow(
        "model setup or inference",
      );
      expect(reloads).toBe(0);
    },
  );

  test("checks current state when acting instead of trusting an idle preview", () => {
    const current = { ...idle };
    expect(rendererRecoveryState(current).canReload).toBe(true);
    current.captureActive = true;
    let reloads = 0;
    expect(() => reloadRenderer(current, () => reloads++)).toThrow(
      "capture or transcription",
    );
    expect(reloads).toBe(0);
  });

  test("keeps reload blocked until all queued settings writes settle", async () => {
    const queue = new SerialQueue();
    let finish!: () => void;
    const first = queue.run(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    let secondSaved = false;
    const second = queue.run(async () => {
      secondSaved = true;
    });
    await Promise.resolve();
    const read = () => ({ ...idle, settingsBusy: queue.busy });
    let reloads = 0;
    expect(() => reloadRenderer(read(), () => reloads++)).toThrow(
      "pending settings changes",
    );
    expect(reloads).toBe(0);
    finish();
    await Promise.all([first, second]);
    reloadRenderer(read(), () => {
      expect(secondSaved).toBe(true);
      reloads++;
    });
    expect(reloads).toBe(1);
  });

  test("does not reload during an update operation", () => {
    let reloads = 0;
    expect(() =>
      reloadRenderer({ ...idle, updateBusy: true }, () => reloads++),
    ).toThrow("current update operation");
    expect(reloads).toBe(0);
  });

  test("runs the idle reload synchronously and exactly once", () => {
    const events: string[] = [];
    expect(rendererRecoveryState(idle)).toEqual({
      canReload: true,
      canStopRecording: false,
      reason: null,
    });
    reloadRenderer(idle, () => events.push("reload"));
    events.push("returned");
    expect(events).toEqual(["reload", "returned"]);
  });

  test("does not offer stop when the authoritative capture is idle", () => {
    expect(
      rendererRecoveryState({ ...idle, canStopRecording: true })
        .canStopRecording,
    ).toBe(false);
  });

  test("reports capture first while allowing a save action amid other blockers", () => {
    const state = rendererRecoveryState({
      captureActive: true,
      canStopRecording: true,
      runtimeBusy: true,
      settingsBusy: true,
      updateBusy: true,
    });
    expect(state.reason).toContain("capture or transcription");
    expect(state.canStopRecording).toBe(true);
  });

  test("surfaces a failed reload without automatically attempting it again", () => {
    let reloads = 0;
    expect(() =>
      reloadRenderer(idle, () => {
        reloads++;
        throw new Error("Renderer could not reload");
      }),
    ).toThrow("Renderer could not reload");
    expect(reloads).toBe(1);
  });
});
