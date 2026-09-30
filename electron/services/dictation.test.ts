import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProfileSnapshot } from "../../src/activePersonalProfile";
import { DEFAULT_SETTINGS } from "../../src/data";
import type {
  AppSettings,
  DictationStatus,
  RecorderCommand,
  TranscriptRecord,
} from "../../src/types";
import type { AsrService } from "./asr";
import type { PasteService } from "./paste";
import type { PillService } from "./pill";
import type { StorageService } from "./storage";

// Bun module mocks share a process-wide export table. Run all capture/delivery
// assertions in their own process so storage/pill mocks cannot race Electron.
if (process.env.DELULU_DICTATION_FIXTURE_ISOLATED !== "1") {
  test("isolated dictation capture and delivery contracts", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, DELULU_DICTATION_FIXTURE_ISOLATED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, output + diagnostic).toBe(0);
    expect(output + diagnostic).toContain("24 pass");
    expect(output + diagnostic).toContain("0 fail");
  }, 15000);
} else {
  // Dictation owns fixture delivery ports; importing its runtime error type still
  // loads Electron permission/clipboard modules, which must stay synthetic.
  mock.module("electron", () => ({
    clipboard: {
      writeText() {
        throw new Error(
          "Unexpected native clipboard access in dictation fixture",
        );
      },
    },
    systemPreferences: {
      getMediaAccessStatus: () => "granted",
      isTrustedAccessibilityClient: () => true,
    },
  }));
  const { DictationService } = await import("./dictation");

  function fakePill() {
    const commands: unknown[] = [];
    return {
      commands,
      service: {
        show: (command: unknown) => commands.push(command),
        hide: () => commands.push({ state: "hidden" }),
        level: (value: number) =>
          commands.push({ state: "listening", level: value }),
      } as unknown as PillService,
    };
  }

  function harness(
    settings: AppSettings,
    transcription: Record<string, unknown> = {
      text: "Ship the release.",
      language: "en",
    },
  ) {
    const cacheDirectory = mkdtempSync(
      join(tmpdir(), "delulu-dictation-test-"),
    );
    const copied: string[] = [];
    const pasted: string[] = [];
    const records: TranscriptRecord[] = [];
    const broadcasts: TranscriptRecord[] = [];
    const commands: RecorderCommand[] = [];
    const activities: { phase: string; message: string }[] = [];
    let status: DictationStatus = {
      phase: "idle",
      engine: "ready",
      message: "Ready",
    };
    let transcriptionCalls = 0;
    let magicCalls = 0;
    let failOnce = false;
    let rewriteFailure = false;
    const recovery: boolean[] = [];
    const storage = {
      cacheDirectory,
      getSettings: () => settings,
      addHistory: (record: TranscriptRecord) => records.push(record),
      findHistory: (id: string) => records.find((record) => record.id === id),
      replaceHistory: (record: TranscriptRecord) => {
        const index = records.findIndex((item) => item.id === record.id);
        if (index >= 0) records[index] = record;
      },
    } as unknown as StorageService;
    const asr = {
      getStatus: () => status,
      setActivity: (phase: DictationStatus["phase"], message: string) => {
        status = { ...status, phase, message };
        activities.push({ phase, message });
      },
      transcribe: async () => {
        transcriptionCalls += 1;
        if (failOnce) {
          failOnce = false;
          throw new Error("Temporary inference failure");
        }
        return transcription;
      },
      setRecovery: (available: boolean) => recovery.push(available),
      rewriteMagic: async () => {
        magicCalls += 1;
        if (rewriteFailure) throw new Error("Writing model unavailable");
        return {
          text: "Ship the release today.",
          model: settings.magicModel,
          processingTimeMs: 12,
          inputCharacters: 17,
          outputCharacters: 23,
          includedInferences: settings.magicAllowInferences,
        };
      },
      unload: async () => undefined,
    } as unknown as AsrService;
    const paste = {
      copy: (text: string) => copied.push(text),
      paste: async (text: string) => {
        pasted.push(text);
        return "test";
      },
    } as unknown as PasteService;
    const pill = fakePill();
    const service = new DictationService(
      storage,
      asr,
      paste,
      {
        main: () =>
          ({
            isDestroyed: () => false,
            webContents: {
              send: (_channel: string, command: RecorderCommand) =>
                commands.push(command),
            },
          }) as never,
        pill: pill.service,
      },
      (record) => broadcasts.push(record),
    );
    service.recorderAvailable();
    return {
      service,
      asr,
      copied,
      pasted,
      records,
      broadcasts,
      commands,
      activities,
      status: () => ({ ...status }),
      transcriptionCalls: () => transcriptionCalls,
      prepareCapture: () => {
        service.start();
        const command = commands.at(-1);
        if (command?.action !== "start" || !command.sessionId)
          throw new Error(
            "The public Start path did not open a capture session",
          );
        service.recordingStarted(command.sessionId);
        service.stop();
        return command.sessionId;
      },
      hud: pill.commands,
      magicCalls: () => magicCalls,
      failRewrite: () => {
        rewriteFailure = true;
      },
      failNext: () => {
        failOnce = true;
      },
      recovery,
      cacheDirectory,
      cleanup: () => rmSync(cacheDirectory, { recursive: true, force: true }),
    };
  }

  function captureHarness(settings: AppSettings = { ...DEFAULT_SETTINGS }) {
    const commands: RecorderCommand[] = [];
    let current = settings;
    let status = { phase: "idle", engine: "ready", message: "Ready" };
    const pill = fakePill();
    const service = new DictationService(
      { getSettings: () => current } as unknown as StorageService,
      {
        getStatus: () => status,
        setActivity: (phase: typeof status.phase, message: string) => {
          status = { ...status, phase, message };
        },
      } as unknown as AsrService,
      {} as PasteService,
      {
        main: () =>
          ({
            isDestroyed: () => false,
            webContents: {
              send: (_channel: string, command: RecorderCommand) =>
                commands.push(command),
            },
          }) as never,
        pill: pill.service,
      },
      () => undefined,
    );
    service.recorderAvailable();
    return {
      service,
      commands,
      sessionId: () => {
        const id = commands.findLast(
          (command) => command.action === "start",
        )?.sessionId;
        if (!id) throw new Error("No public capture session was opened");
        return id;
      },
      hud: pill.commands,
      setPhase: (phase: string) => {
        status = { ...status, phase };
      },
      setSettings: (next: AppSettings) => {
        current = next;
      },
    };
  }

  test("a controller disconnect during submitted inference cannot admit another capture", async () => {
    const h = harness({
      ...DEFAULT_SETTINGS,
      magicEnabled: false,
      autoPaste: false,
    });
    let finish!: (result: Record<string, unknown>) => void;
    h.asr.transcribe = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    try {
      const pending = h.service.submitRecording({
        sessionId: h.prepareCapture(),
        wav: new Uint8Array(128),
        durationMs: 1000,
      });
      await Promise.resolve();
      expect(h.service.isActive).toBe(true);
      expect(h.service.canStopRecording).toBe(false);
      h.service.recorderUnavailable();
      expect(h.service.isActive).toBe(true);
      h.service.start();
      expect(h.service.isActive).toBe(true);
      finish({ text: "Original submitted speech", language: "en" });
      await pending;
      expect(h.service.isActive).toBe(false);
      expect(h.records[0].text).toBe("Original submitted speech");
    } finally {
      h.cleanup();
    }
  });

  describe("dictation delivery pipeline", () => {
    for (const action of ["stop", "cancel", "ready"] as const) {
      test(`busy notice clears on ${action} without starting a recording`, () => {
        const h = captureHarness();
        h.setPhase("loading");
        h.service.start();
        expect(h.commands).toHaveLength(0);
        expect(h.service.isActive).toBe(false);
        if (action === "ready") {
          h.setPhase("idle");
          h.service.runtimeChanged();
        } else h.service[action]();
        expect(h.hud.at(-1)).toMatchObject({ state: "hidden" });
      });
    }
    test("busy notice expires even without a later runtime event", async () => {
      const h = captureHarness();
      h.setPhase("loading");
      h.service.start();
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(h.hud.at(-1)).toMatchObject({ state: "hidden" });
    });
    test("old busy notice cannot hide a subsequent recording", async () => {
      const h = captureHarness();
      h.setPhase("loading");
      h.service.start();
      h.setPhase("idle");
      h.service.start();
      h.service.recordingStarted(h.sessionId());
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect((h.hud.at(-1) as { state: string }).state).toBe("listening");
      h.service.cancel();
    });
    test("honors a hold release that arrives while the microphone is still opening", () => {
      const testHarness = captureHarness();
      testHarness.service.start();
      testHarness.service.stop();
      expect(testHarness.commands).toEqual([
        {
          action: "start",
          trailingSilence: null,
          captureProfile: captureProfileSnapshot(DEFAULT_SETTINGS),
          inputDeviceId: "default",
          sessionId: testHarness.sessionId(),
        },
      ]);
      testHarness.service.recordingStarted(testHarness.sessionId());
      expect(testHarness.commands).toEqual([
        {
          action: "start",
          trailingSilence: null,
          captureProfile: captureProfileSnapshot(DEFAULT_SETTINGS),
          inputDeviceId: "default",
          sessionId: testHarness.sessionId(),
        },
        {
          action: "stop",
          inputDeviceId: "default",
          sessionId: testHarness.sessionId(),
        },
      ]);
    });

    test("a second toggle also stops a capture whose microphone is still opening", () => {
      const testHarness = captureHarness();
      testHarness.service.toggle();
      testHarness.service.toggle();
      testHarness.service.recordingStarted(testHarness.sessionId());
      expect(testHarness.commands.at(-1)).toEqual({
        action: "stop",
        inputDeviceId: "default",
        sessionId: testHarness.sessionId(),
      });
    });

    test("rewrites with Magic before copying the delivered result", async () => {
      const testHarness = harness({
        ...DEFAULT_SETTINGS,
        magicEnabled: true,
        magicPreset: "polish",
        magicAllowInferences: false,
        autoPaste: false,
        copyToClipboard: true,
      });
      try {
        await testHarness.service.submitRecording({
          sessionId: testHarness.prepareCapture(),
          wav: new Uint8Array(64),
          durationMs: 1_000,
        });
        expect(testHarness.magicCalls()).toBe(1);
        expect(testHarness.copied).toEqual(["Ship the release today."]);
        expect(testHarness.records[0].magicText).toBe(
          "Ship the release today.",
        );
        expect(testHarness.records[0].text).toBe("Ship the release.");
      } finally {
        testHarness.cleanup();
      }
    });

    test("delivers the speech transcript directly when Magic is off", async () => {
      const testHarness = harness({
        ...DEFAULT_SETTINGS,
        magicEnabled: false,
        autoPaste: false,
        copyToClipboard: true,
      });
      try {
        await testHarness.service.submitRecording({
          sessionId: testHarness.prepareCapture(),
          wav: new Uint8Array(64),
          durationMs: 1_000,
        });
        expect(testHarness.magicCalls()).toBe(0);
        expect(testHarness.copied).toEqual(["Ship the release."]);
        expect(testHarness.records[0].magicText).toBeUndefined();
      } finally {
        testHarness.cleanup();
      }
    });

    test("automatic paste publishes the result exactly once", async () => {
      const testHarness = harness({
        ...DEFAULT_SETTINGS,
        magicEnabled: false,
        autoPaste: true,
        copyToClipboard: true,
      });
      try {
        await testHarness.service.submitRecording({
          sessionId: testHarness.prepareCapture(),
          wav: new Uint8Array(64),
          durationMs: 1_000,
        });
        expect(testHarness.copied).toEqual([]);
        expect(testHarness.pasted).toEqual(["Ship the release."]);
        expect(testHarness.hud.at(-1)).toMatchObject({
          state: "success",
          title: "Paste attempted",
          detail: "Destination unconfirmed",
        });
      } finally {
        testHarness.cleanup();
      }
    });

    test("does not save, rewrite, copy, or paste silence", async () => {
      const testHarness = harness(
        {
          ...DEFAULT_SETTINGS,
          magicEnabled: true,
          autoPaste: true,
          copyToClipboard: true,
        },
        { text: "", language: "en" },
      );
      try {
        await testHarness.service.submitRecording({
          sessionId: testHarness.prepareCapture(),
          wav: new Uint8Array(64),
          durationMs: 1_000,
        });
        expect(testHarness.magicCalls()).toBe(0);
        expect(testHarness.copied).toEqual([]);
        expect(testHarness.records).toEqual([]);
        expect(testHarness.hud.at(-1)).toMatchObject({
          state: "error",
          profile: "Global settings",
        });
      } finally {
        testHarness.cleanup();
      }
    });

    test("shows a short copied success state after delivery", async () => {
      const testHarness = harness({
        ...DEFAULT_SETTINGS,
        magicEnabled: false,
        autoPaste: false,
        copyToClipboard: true,
      });
      try {
        await testHarness.service.submitRecording({
          sessionId: testHarness.prepareCapture(),
          wav: new Uint8Array(64),
          durationMs: 1_000,
        });
        expect(testHarness.hud).toContainEqual({
          state: "transcribing",
          profile: "Global settings",
        });
        expect(testHarness.hud.at(-1)).toMatchObject({
          state: "success",
          title: "Copied",
          detail: "Ready to keep talking",
        });
      } finally {
        testHarness.cleanup();
      }
    });

    test("discards a tap as too short instead of hiding silently", async () => {
      const testHarness = harness({
        ...DEFAULT_SETTINGS,
      });
      try {
        await testHarness.service.submitRecording({
          sessionId: testHarness.prepareCapture(),
          wav: new Uint8Array(64),
          durationMs: 80,
        });
        expect(testHarness.copied).toEqual([]);
        expect(testHarness.hud.at(-1)).toMatchObject({
          state: "error",
          title: "Too short",
          detail: "Hold a little longer",
        });
      } finally {
        testHarness.cleanup();
      }
    });

    test("reapplies the current HUD when the overlay setting flips", () => {
      const testHarness = captureHarness();
      testHarness.service.start();
      testHarness.service.recordingStarted(testHarness.sessionId());
      expect(testHarness.hud.at(-1)).toMatchObject({
        state: "listening",
        detail: "Release to send",
      });
      testHarness.setSettings({
        ...DEFAULT_SETTINGS,
        showOverlay: false,
      });
      testHarness.service.syncOverlay();
      expect(testHarness.hud.at(-1)).toMatchObject({ state: "hidden" });
      testHarness.setSettings({
        ...DEFAULT_SETTINGS,
        showOverlay: true,
      });
      testHarness.service.syncOverlay();
      expect(testHarness.hud.at(-1)).toMatchObject({
        state: "listening",
        detail: "Release to send",
      });
    });
  });

  test("failed inference can retry from memory while temporary audio is deleted", async () => {
    const h = harness({ ...DEFAULT_SETTINGS, magicEnabled: false });
    try {
      h.failNext();
      await h.service.submitRecording({
        sessionId: h.prepareCapture(),
        wav: new Uint8Array(100),
        durationMs: 1000,
      });
      expect(h.service.isActive).toBe(false);
      expect(h.recovery.at(-1)).toBe(true);
      expect(h.records).toHaveLength(0);
      expect(readdirSync(h.cacheDirectory)).toEqual([]);
      await h.service.retry();
      expect(h.recovery.at(-1)).toBe(false);
      expect(h.pasted).toHaveLength(1);
      expect(readdirSync(h.cacheDirectory)).toEqual([]);
      await expect(h.service.retry()).rejects.toThrow("No failed recording");
    } finally {
      h.cleanup();
    }
  });

  test("personalization changes delivery without corrupting source speech or timing", async () => {
    const h = harness(
      {
        ...DEFAULT_SETTINGS,
        autoPaste: false,
        customWords: [
          {
            id: "name",
            term: "Delulu",
            soundsLike: "the lulu",
            replacement: "",
            enabled: true,
          },
        ],
      },
      {
        text: "Open the lulu.",
        language: "en",
      },
    );
    try {
      await h.service.submitRecording({
        sessionId: h.prepareCapture(),
        wav: new Uint8Array(128),
        durationMs: 1000,
      });
      expect(h.copied).toEqual(["Open Delulu."]);
      expect(h.records[0].text).toBe("Open the lulu.");
      expect(h.records[0].personalizedText).toBe("Open Delulu.");
      expect(h.magicCalls()).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("failed automatic writing delivers the personalized transcript once", async () => {
    const h = harness({
      ...DEFAULT_SETTINGS,
      magicEnabled: true,
      autoPaste: true,
      customWords: [
        {
          id: "s",
          kind: "shortcut",
          term: "the release",
          soundsLike: "",
          replacement: "version 0.8.0",
          enabled: true,
        },
      ],
    });
    h.failRewrite();
    try {
      await h.service.submitRecording({
        sessionId: h.prepareCapture(),
        wav: new Uint8Array(128),
        durationMs: 1000,
      });
      expect(h.pasted).toEqual(["Ship version 0.8.0."]);
      expect(h.records[0].text).toBe("Ship the release.");
      expect(h.records[0].magicText).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  describe("capture session ownership", () => {
    for (const newerCapture of [false, true]) {
      test(`cancelled audio is inert ${newerCapture ? "while a new microphone is opening" : "while idle"}`, async () => {
        const h = harness({ ...DEFAULT_SETTINGS, magicEnabled: true });
        try {
          const abandoned = h.prepareCapture();
          h.service.cancel();
          if (newerCapture) h.service.start();
          const current = h.commands.at(-1)?.sessionId;
          const commands = h.commands.length;
          const activities = h.activities.length;
          const hud = h.hud.length;
          await h.service.submitRecording({
            sessionId: abandoned,
            wav: new Uint8Array(128),
            durationMs: 1000,
          });
          expect(h.transcriptionCalls()).toBe(0);
          expect(h.magicCalls()).toBe(0);
          expect(h.records).toEqual([]);
          expect(h.broadcasts).toEqual([]);
          expect(h.copied).toEqual([]);
          expect(h.pasted).toEqual([]);
          expect(readdirSync(h.cacheDirectory)).toEqual([]);
          expect(h.commands).toHaveLength(commands);
          expect(h.activities).toHaveLength(activities);
          expect(h.hud).toHaveLength(hud);
          expect(h.service.isActive).toBe(newerCapture);
          expect(h.service.canStopRecording).toBe(newerCapture);
          if (newerCapture) {
            expect(current).not.toBe(abandoned);
            h.service.recordingStarted(current!);
            h.service.stop();
            await h.service.submitRecording({
              sessionId: current!,
              wav: new Uint8Array(128),
              durationMs: 1000,
            });
            expect(h.transcriptionCalls()).toBe(1);
            expect(h.records).toHaveLength(1);
            expect(h.broadcasts).toHaveLength(3);
            expect(new Set(h.broadcasts.map((record) => record.id)).size).toBe(
              1,
            );
            expect(h.pasted).toHaveLength(1);
          }
        } finally {
          h.cleanup();
        }
      });
    }

    test("old Started and Failed callbacks do not change a newer opening session", () => {
      const h = harness({ ...DEFAULT_SETTINGS });
      try {
        const abandoned = h.prepareCapture();
        h.service.cancel();
        h.service.start();
        const current = h.commands.at(-1)!.sessionId!;
        expect(current).not.toBe(abandoned);
        const before = h.status();
        const commands = h.commands.length;
        const activities = h.activities.length;
        const hud = h.hud.length;
        h.service.recordingStarted(abandoned);
        h.service.recordingFailed("A previous microphone failed", abandoned);
        expect(h.status()).toEqual(before);
        expect(h.commands).toHaveLength(commands);
        expect(h.activities).toHaveLength(activities);
        expect(h.hud).toHaveLength(hud);
        expect(h.service.canStopRecording).toBe(true);
        h.service.recordingStarted(current);
        expect(h.status().phase).toBe("listening");
        h.service.recordingFailed("Current microphone failed", current);
        expect(h.status().message).toBe("Current microphone failed");
        expect(h.service.isActive).toBe(false);
      } finally {
        h.cleanup();
      }
    });

    test("duplicate audio and late callbacks cannot clobber processing or duplicate delivery", async () => {
      const h = harness({ ...DEFAULT_SETTINGS, magicEnabled: true });
      let finish!: (result: Record<string, unknown>) => void;
      let inferenceCalls = 0;
      h.asr.transcribe = () => {
        inferenceCalls += 1;
        return new Promise((resolve) => {
          finish = resolve;
        });
      };
      try {
        const sessionId = h.prepareCapture();
        const audio = { sessionId, wav: new Uint8Array(128), durationMs: 1000 };
        const pending = h.service.submitRecording(audio);
        expect(inferenceCalls).toBe(1);
        expect(h.service.isActive).toBe(true);
        expect(h.service.canStopRecording).toBe(false);
        const before = h.status();
        const activities = h.activities.length;
        const hud = h.hud.length;
        const commands = h.commands.length;
        const files = readdirSync(h.cacheDirectory);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^dictation-.*\.wav$/);
        await h.service.submitRecording(audio);
        h.service.recordingStarted(sessionId);
        h.service.recordingFailed(
          "Late failure after audio was submitted",
          sessionId,
        );
        h.service.cancel();
        h.service.stop();
        h.service.start();
        expect(inferenceCalls).toBe(1);
        expect(h.status()).toEqual(before);
        expect(h.activities).toHaveLength(activities);
        expect(h.hud).toHaveLength(hud);
        expect(h.commands).toHaveLength(commands);
        expect(readdirSync(h.cacheDirectory)).toEqual(files);
        expect(h.records).toEqual([]);
        expect(h.broadcasts).toEqual([]);
        expect(h.pasted).toEqual([]);
        finish({ text: "Ship the release.", language: "en" });
        await pending;
        expect(h.magicCalls()).toBe(1);
        expect(h.records).toHaveLength(1);
        expect(h.broadcasts).toHaveLength(3);
        expect(new Set(h.broadcasts.map((record) => record.id)).size).toBe(1);
        expect(h.pasted).toEqual(["Ship the release today."]);
        expect(readdirSync(h.cacheDirectory)).toEqual([]);
        expect(h.service.isActive).toBe(false);
        const complete = h.status();
        await h.service.submitRecording(audio);
        h.service.recordingStarted(sessionId);
        h.service.recordingFailed("Late failure after delivery", sessionId);
        expect(h.status()).toEqual(complete);
        expect(inferenceCalls).toBe(1);
        expect(h.records).toHaveLength(1);
        expect(h.broadcasts).toHaveLength(3);
        expect(new Set(h.broadcasts.map((record) => record.id)).size).toBe(1);
        expect(h.pasted).toHaveLength(1);
        expect(readdirSync(h.cacheDirectory)).toEqual([]);
      } finally {
        h.cleanup();
      }
    });

    test("mismatched audio cannot consume the stopping session's valid submission", async () => {
      const h = harness({ ...DEFAULT_SETTINGS, magicEnabled: false });
      try {
        const sessionId = h.prepareCapture();
        await h.service.submitRecording({
          sessionId: "unrelated-session",
          wav: new Uint8Array(128),
          durationMs: 1000,
        });
        expect(h.transcriptionCalls()).toBe(0);
        expect(h.service.isActive).toBe(true);
        expect(h.service.canStopRecording).toBe(false);
        expect(readdirSync(h.cacheDirectory)).toEqual([]);
        await h.service.submitRecording({
          sessionId,
          wav: new Uint8Array(128),
          durationMs: 1000,
        });
        expect(h.transcriptionCalls()).toBe(1);
        expect(h.records).toHaveLength(1);
        expect(h.broadcasts).toHaveLength(3);
        expect(new Set(h.broadcasts.map((record) => record.id)).size).toBe(1);
        expect(h.pasted).toHaveLength(1);
      } finally {
        h.cleanup();
      }
    });

    test("interleaved shared UI, tray and shortcut actions preserve one hold-release session", async () => {
      const h = harness({
        ...DEFAULT_SETTINGS,
        shortcutMode: "hold",
        magicEnabled: false,
      });
      try {
        h.service.start(); // UI Record.
        h.service.start(); // Tray Record while microphone permission is pending.
        const sessionId = h.commands[0].sessionId!;
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
        h.service.stop(); // Held shortcut release while opening.
        h.service.toggle(); // UI toggle while closing.
        h.service.stop(); // Tray Stop while closing.
        expect(h.commands).toEqual([
          {
            action: "start",
            trailingSilence: null,
            captureProfile: captureProfileSnapshot(DEFAULT_SETTINGS),
            inputDeviceId: "default",
            sessionId,
          },
        ]);
        h.service.recordingStarted(sessionId);
        h.service.stop(); // Repeated shortcut release.
        h.service.toggle(); // Repeated toggle cannot restart stopping capture.
        expect(h.commands).toEqual([
          {
            action: "start",
            trailingSilence: null,
            captureProfile: captureProfileSnapshot(DEFAULT_SETTINGS),
            inputDeviceId: "default",
            sessionId,
          },
          { action: "stop", inputDeviceId: "default", sessionId },
        ]);
        await h.service.submitRecording({
          sessionId,
          wav: new Uint8Array(128),
          durationMs: 1000,
        });
        expect(h.transcriptionCalls()).toBe(1);
        expect(h.records).toHaveLength(1);
        expect(h.broadcasts).toHaveLength(3);
        expect(new Set(h.broadcasts.map((record) => record.id)).size).toBe(1);
        expect(h.pasted).toHaveLength(1);
        h.service.toggle(); // Tray toggle opens another capture.
        const nextId = h.commands.at(-1)!.sessionId!;
        expect(nextId).not.toBe(sessionId);
        h.service.cancel(); // UI Cancel before input opens.
        h.service.stop(); // Shortcut release after cancellation.
        h.service.recordingStarted(nextId);
        await h.service.submitRecording({
          sessionId: nextId,
          wav: new Uint8Array(128),
          durationMs: 1000,
        });
        expect(h.commands.slice(-2)).toEqual([
          {
            action: "start",
            trailingSilence: null,
            captureProfile: captureProfileSnapshot(DEFAULT_SETTINGS),
            inputDeviceId: "default",
            sessionId: nextId,
          },
          { action: "cancel", inputDeviceId: "default", sessionId: nextId },
        ]);
        expect(h.transcriptionCalls()).toBe(1);
        expect(h.records).toHaveLength(1);
        expect(h.broadcasts).toHaveLength(3);
        expect(new Set(h.broadcasts.map((record) => record.id)).size).toBe(1);
        expect(h.pasted).toHaveLength(1);
        expect(h.service.isActive).toBe(false);
        expect(readdirSync(h.cacheDirectory)).toEqual([]);
      } finally {
        h.cleanup();
      }
    });
  });
}
