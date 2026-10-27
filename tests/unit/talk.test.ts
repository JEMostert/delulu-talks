import { expect, test } from "bun:test";
import {
  INITIAL_TALK_STATUS,
  agentsLine,
  dbToLevel,
  helperLine,
  helperTone,
  meterStep,
  normalizeHelperMode,
  talkLine,
  toolLabel,
  type TalkStatus,
} from "../../src/talk";
import { microphoneOptions } from "../../src/microphoneSelection";
import { parseTalkStart } from "../../src/ipcRequests";

const status = (patch: Partial<TalkStatus> = {}): TalkStatus => ({
  ...INITIAL_TALK_STATUS,
  ...patch,
});

test("dBFS maps −60…0 onto the meter and clamps outside it", () => {
  expect(dbToLevel(-60)).toBe(0);
  expect(dbToLevel(-30)).toBe(0.5);
  expect(dbToLevel(0)).toBe(1);
  expect(dbToLevel(-90)).toBe(0);
  expect(dbToLevel(6)).toBe(1);
  expect(dbToLevel(Number.NEGATIVE_INFINITY)).toBe(0);
  expect(dbToLevel(Number.NaN)).toBe(0);
});

test("the meter rises quickly and decays smoothly", () => {
  expect(meterStep(0, 0.8, 40)).toBeCloseTo(0.8);
  expect(meterStep(0, 0.8, 20)).toBeCloseTo(0.4);
  const fallen = meterStep(0.8, 0, 100);
  expect(fallen).toBeLessThan(0.8);
  expect(fallen).toBeGreaterThan(0.6);
  // It never falls below the current level, and settles at zero.
  expect(meterStep(0.5, 0.45, 1000)).toBe(0.45);
  expect(meterStep(0.001, 0, 16)).toBe(0);
  expect(meterStep(0.3, 0.3, Number.NaN)).toBe(0.3);
});

test("tools get short human labels", () => {
  expect(toolLabel("send_to_agent")).toBe("Sent to agent");
  expect(toolLabel("task_status")).toBe("Status");
  expect(toolLabel("cancel_task")).toBe("Cancel");
  expect(toolLabel("stop_speaking")).toBe("Stopped speaking");
  expect(toolLabel("stop_listening")).toBe("Stopped listening");
  expect(toolLabel("repeat_last")).toBe("Repeated");
  expect(toolLabel("reply")).toBe("Replied");
  expect(toolLabel(null)).toBeNull();
  expect(toolLabel("toString")).toBeNull();
});

test("legacy conversational mode is Lightweight", () => {
  expect(normalizeHelperMode("conversational")).toBe("lightweight");
  expect(normalizeHelperMode("lightweight")).toBe("lightweight");
  expect(normalizeHelperMode("off")).toBe("off");
  expect(normalizeHelperMode(undefined)).toBe("off");
});

test("the Sonar line follows the loop and explains why it is off", () => {
  expect(talkLine(status(), true)).toBe("Talk to your agents hands-free");
  expect(talkLine(status(), false)).toBe("Set up speech in Engines first");
  expect(talkLine(status({ needsDownload: true }), true)).toBe(
    "Pilot needs a one-time download",
  );
  expect(talkLine(status({ on: true, phase: "thinking" }), true)).toBe(
    "Thinking…",
  );
  expect(
    talkLine(
      status({ on: true, phase: "hearing", message: "Hearing you" }),
      true,
    ),
  ).toBe("Hearing you");
  expect(
    talkLine(
      status({ phase: "failed", message: "Microphone unavailable" }),
      true,
    ),
  ).toBe("Microphone unavailable");
});

test("the Pilot line reports its state for the selected mode", () => {
  const helper = (state: TalkStatus["helper"]["state"], message = "") =>
    status({ helper: { mode: "lightweight", state, message } });
  expect(helperLine(status(), "off")).toBe(
    "Your words go straight to your agent",
  );
  expect(helperTone(status(), "off")).toBe("");
  expect(helperLine(helper("missing"), "lightweight")).toBe("Not downloaded");
  expect(helperTone(helper("missing"), "lightweight")).toBe("warning");
  expect(helperLine(helper("ready"), "lightweight")).toBe("Ready");
  expect(helperTone(helper("ready"), "lightweight")).toBe("ready");
  expect(helperLine(helper("failed", "Out of memory"), "lightweight")).toBe(
    "Out of memory",
  );
  expect(helperTone(helper("failed"), "lightweight")).toBe("error");
  expect(
    helperLine(
      status({
        phase: "downloading",
        message: "Downloading the helper · 40%",
        helper: { mode: "lightweight", state: "missing", message: "" },
      }),
      "lightweight",
    ),
  ).toBe("Downloading…");
  expect(
    helperLine(
      status({
        phase: "downloading",
        helper: { mode: "lightweight", state: "loading", message: "1.1 GB" },
      }),
      "lightweight",
    ),
  ).toBe("1.1 GB");
  // Saved but not yet picked up by the desktop.
  expect(helperLine(status(), "lightweight")).toBe("Switching…");
});

test("agents read as name · listening or away", () => {
  expect(agentsLine([])).toBe("No agent connected");
  expect(
    agentsLine([
      { id: "a", name: "Claude Code", listening: true, openTasks: 1 },
      { id: "b", name: "Codex", listening: false, openTasks: 0 },
    ]),
  ).toBe("Claude Code · listening, Codex · away");
});

test("the microphone picker always offers System default", () => {
  const saved = {
    inputDeviceId: "default",
    inputDeviceLabel: "System default",
  };
  expect(
    microphoneOptions(saved, [
      { deviceId: "default", label: "Default" },
      { deviceId: "usb", label: "USB Microphone" },
    ]),
  ).toEqual([
    { value: "default", label: "System default" },
    { value: "usb", label: "USB Microphone" },
  ]);
  expect(microphoneOptions(saved, [])).toEqual([
    { value: "default", label: "System default" },
  ]);
  expect(
    microphoneOptions({ inputDeviceId: "jack", inputDeviceLabel: "Headset" }, [
      { deviceId: "usb", label: "USB Microphone" },
    ]).map((option) => option.label),
  ).toEqual(["System default", "Headset (not listed)", "USB Microphone"]);
});

test("talk:start always sends one download flag", () => {
  expect(parseTalkStart([])).toEqual([{ download: false }]);
  expect(parseTalkStart([undefined])).toEqual([{ download: false }]);
  expect(parseTalkStart([{}])).toEqual([{ download: false }]);
  expect(parseTalkStart([{ download: true }])).toEqual([{ download: true }]);
  expect(() => parseTalkStart([{ download: "yes" }])).toThrow();
  expect(() => parseTalkStart([{ other: true }])).toThrow();
  expect(() => parseTalkStart([{}, {}])).toThrow();
});
