import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss setup" }).click();
});

// Actual Chromium microphone, contexts and unmodified production worklet. Only
// desktop IPC and the timing of a flush/permission response are controlled.
async function exerciseRace(
  page: Page,
  scenario:
    | "cancel-flush"
    | "duplicates"
    | "permission-restart"
    | "permission-stale-cancel"
    | "stale-commands"
    | "submission-restart",
) {
  return page.evaluate(async (scenario) => {
    const { PcmRecorder } = await import(/* @vite-ignore */ "/src/recorder.ts");
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    const permissionRestart =
      scenario === "permission-restart" ||
      scenario === "permission-stale-cancel";
    const NativeContext = window.AudioContext;
    const NativeWorklet = window.AudioWorkletNode;
    const getUserMedia = navigator.mediaDevices.getUserMedia;
    const originalBridge = {
      recordingStarted: bridge.recordingStarted,
      recordingLevel: bridge.recordingLevel,
      recordingFailed: bridge.recordingFailed,
      submitRecording: bridge.submitRecording,
    };
    const contexts: AudioContext[] = [];
    const streams: MediaStream[] = [];
    const worklets: AudioWorkletNode[] = [];
    const failures: string[] = [];
    const submissions: {
      samples: number;
      released: boolean;
      sessionId?: string;
    }[] = [];
    const startedSessions: (string | undefined)[] = [];
    let started = 0;
    let acquisition = 0;
    let flushes = 0;
    let acknowledged = 0;
    let releaseFlush: (() => void) | undefined;
    let flushEntered!: () => void;
    const pendingFlush = new Promise<void>((resolve) => {
      flushEntered = resolve;
    });
    let releasePermission!: () => void;
    let permissionEntered!: () => void;
    const pendingPermission = new Promise<void>((resolve) => {
      permissionEntered = resolve;
    });
    let releaseSubmission: (() => void) | undefined;
    let submissionEntered!: () => void;
    const pendingSubmission = new Promise<void>((resolve) => {
      submissionEntered = resolve;
    });
    let audioReady!: () => void;
    let heardAudio = new Promise<void>((resolve) => {
      audioReady = resolve;
    });
    const released = () =>
      streams.every((stream) =>
        stream.getTracks().every((track) => track.readyState === "ended"),
      ) &&
      contexts.every((context) => context.state === "closed") &&
      worklets.every((node) => node.port.onmessage === null);
    async function within<T>(operation: Promise<T>, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label}: ${failures.join("; ")}`)),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sampleRate: 16_000 });
        contexts.push(this);
      }
    };
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(
        context: BaseAudioContext,
        name: string,
        options?: AudioWorkletNodeOptions,
      ) {
        super(context, name, options);
        worklets.push(this);
        const ready = audioReady;
        this.addEventListener("processorerror", () =>
          failures.push("processorerror"),
        );
        const postMessage = this.port.postMessage.bind(this.port);
        this.port.postMessage = (message: unknown) => {
          if (message === "flush") {
            flushes += 1;
            if (scenario === "cancel-flush" && !releaseFlush) {
              releaseFlush = () => postMessage(message);
              flushEntered();
              return;
            }
          }
          postMessage(message);
        };
        this.port.addEventListener("message", (event) => {
          if (event.data.samples?.some((sample: number) => sample !== 0))
            ready();
          if (event.data.flushed) acknowledged += 1;
        });
        this.port.start();
      }
    };
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      acquisition += 1;
      if (permissionRestart && acquisition === 1) {
        const permission = new Promise<void>((resolve) => {
          releasePermission = resolve;
        });
        permissionEntered();
        await permission;
      }
      const stream = await getUserMedia.call(this, constraints);
      streams.push(stream);
      return stream;
    };
    bridge.recordingStarted = async (sessionId?: string) => {
      started += 1;
      startedSessions.push(sessionId);
      await contexts.at(-1)!.resume();
    };
    bridge.recordingLevel = () => {};
    bridge.recordingFailed = async (message: string) => {
      failures.push(message);
    };
    bridge.submitRecording = async (value: {
      wav: Uint8Array;
      sessionId?: string;
    }) => {
      submissions.push({
        samples: (value.wav.length - 44) / 2,
        released: released(),
        sessionId: value.sessionId,
      });
      if (scenario === "submission-restart" && submissions.length === 1) {
        const waiting = new Promise<void>((resolve) => {
          releaseSubmission = resolve;
        });
        submissionEntered();
        await waiting;
      }
    };
    const recorder = new PcmRecorder();
    let sessionId = "abandoned-session";
    const start = () =>
      recorder.handle({ action: "start", inputDeviceId: "default", sessionId });
    const stop = () =>
      recorder.handle({ action: "stop", inputDeviceId: "default", sessionId });
    const cancel = (id = sessionId) =>
      recorder.handle({
        action: "cancel",
        inputDeviceId: "default",
        sessionId: id,
      });
    let staleCommandsPreservedCapture = true;
    try {
      if (permissionRestart) {
        const opening = start();
        await within(pendingPermission, "Permission was not requested");
        const cancelling = cancel();
        sessionId = "current-session";
        const reopening = start();
        // A still owns its pending permission operation, but B already owns
        // the next reservation. A delayed duplicate Cancel must affect only A.
        const staleCancel =
          scenario === "permission-stale-cancel"
            ? cancel("abandoned-session")
            : Promise.resolve();
        releasePermission();
        await within(
          Promise.all([opening, cancelling, reopening, staleCancel]),
          "Cancelled permission response or new capture did not settle",
        );
      } else if (scenario === "stale-commands") {
        await within(start(), "Original capture did not start");
        await cancel();
        sessionId = "current-session";
        heardAudio = new Promise<void>((resolve) => {
          audioReady = resolve;
        });
        await within(start(), "New capture did not start");
      } else {
        await within(
          Promise.all(
            scenario === "duplicates" ? [start(), start()] : [start()],
          ),
          "Microphone start did not settle",
        );
      }
      await within(
        heardAudio,
        `Real worklet did not deliver microphone audio (starts=${startedSessions.join(",")}; acquisitions=${acquisition}; contexts=${contexts.length})`,
      );
      const liveBeforeStop = streams
        .at(-1)!
        .getTracks()
        .every((track) => track.readyState === "live");
      if (scenario === "cancel-flush") {
        const stopping = stop();
        await within(pendingFlush, "Stop did not request a worklet flush");
        const cancelling = cancel();
        releaseFlush!();
        await within(
          Promise.all([stopping, cancelling]),
          "Stop/Cancel race did not settle",
        );
      } else if (scenario === "submission-restart") {
        const stopping = stop();
        await within(pendingSubmission, "Capture was not submitted");
        // Main has finished the old operation and sent a new command while
        // the old recorder's IPC response is still pending delivery.
        sessionId = "current-session";
        heardAudio = new Promise<void>((resolve) => {
          audioReady = resolve;
        });
        const reopening = start();
        releaseSubmission!();
        await within(Promise.all([stopping, reopening]), "New Start was lost");
        await within(
          heardAudio,
          "New capture did not receive microphone audio",
        );
        await stop();
      } else {
        if (scenario === "stale-commands") {
          await recorder.handle({
            action: "stop",
            inputDeviceId: "default",
            sessionId: "abandoned-session",
          });
          await cancel("abandoned-session");
          staleCommandsPreservedCapture =
            submissions.length === 0 &&
            streams
              .at(-1)!
              .getTracks()
              .every((track) => track.readyState === "live") &&
            contexts.at(-1)!.state === "running";
        }
        await within(
          Promise.all(scenario === "duplicates" ? [stop(), stop()] : [stop()]),
          "Stop did not settle",
        );
      }
      await stop();
      return {
        started,
        startedSessions,
        acquisition,
        streams: streams.length,
        contexts: contexts.length,
        worklets: worklets.length,
        flushes,
        acknowledged,
        failures,
        submissions,
        liveBeforeStop,
        released: released(),
        staleCommandsPreservedCapture,
        abandonedPermissionTrackEnded:
          !permissionRestart ||
          streams[0].getTracks().every((track) => track.readyState === "ended"),
      };
    } finally {
      releasePermission?.();
      releaseFlush?.();
      releaseSubmission?.();
      await recorder.cancel();
      streams.forEach((stream) =>
        stream.getTracks().forEach((track) => track.stop()),
      );
      await Promise.all(
        contexts
          .filter((context) => context.state !== "closed")
          .map((context) => context.close()),
      );
      window.AudioContext = NativeContext;
      window.AudioWorkletNode = NativeWorklet;
      navigator.mediaDevices.getUserMedia = getUserMedia;
      Object.assign(bridge, originalBridge);
    }
  }, scenario);
}

test("Cancel during Stop's pending worklet flush discards audio before submission", async ({
  page,
}) => {
  const result = await exerciseRace(page, "cancel-flush");
  expect(result.failures).toEqual([]);
  expect(result.started).toBe(1);
  expect(result.startedSessions).toEqual(["abandoned-session"]);
  expect(result.streams).toBe(1);
  expect(result.contexts).toBe(1);
  expect(result.worklets).toBe(1);
  expect(result.liveBeforeStop).toBe(true);
  expect(result.flushes).toBe(1);
  expect(result.submissions).toEqual([]);
  expect(result.released).toBe(true);
});

test("a new Start survives a previous submission's pending IPC reply", async ({
  page,
}) => {
  const result = await exerciseRace(page, "submission-restart");
  expect(result.failures).toEqual([]);
  expect(result.startedSessions).toEqual([
    "abandoned-session",
    "current-session",
  ]);
  expect(result.streams).toBe(2);
  expect(result.contexts).toBe(2);
  expect(result.submissions.map((submission) => submission.sessionId)).toEqual([
    "abandoned-session",
    "current-session",
  ]);
  expect(result.submissions.every((submission) => submission.released)).toBe(
    true,
  );
  expect(result.released).toBe(true);
});

test("concurrent duplicate Start and Stop each preserve one native capture and submission", async ({
  page,
}) => {
  const result = await exerciseRace(page, "duplicates");
  expect(result.failures).toEqual([]);
  expect(result.started).toBe(1);
  expect(result.startedSessions).toEqual(["abandoned-session"]);
  expect(result.acquisition).toBe(1);
  expect(result.streams).toBe(1);
  expect(result.contexts).toBe(1);
  expect(result.worklets).toBe(1);
  expect(result.flushes).toBe(1);
  expect(result.acknowledged).toBe(1);
  expect(result.submissions).toHaveLength(1);
  expect(result.submissions[0].samples).toBeGreaterThan(0);
  expect(result.submissions[0].released).toBe(true);
  expect(result.submissions[0].sessionId).toBe("abandoned-session");
  expect(result.released).toBe(true);
});

test("Cancel during pending permission releases the abandoned stream and preserves queued new Start", async ({
  page,
}) => {
  const result = await exerciseRace(page, "permission-restart");
  expect(result.failures).toEqual([]);
  expect(result.started).toBe(1);
  expect(result.startedSessions).toEqual(["current-session"]);
  expect(result.acquisition).toBe(2);
  expect(result.streams).toBe(2);
  expect(result.contexts).toBe(1);
  expect(result.worklets).toBe(1);
  expect(result.abandonedPermissionTrackEnded).toBe(true);
  expect(result.submissions).toHaveLength(1);
  expect(result.submissions[0].samples).toBeGreaterThan(0);
  expect(result.submissions[0].sessionId).toBe("current-session");
  expect(result.released).toBe(true);
});

test("late tagged Stop and Cancel cannot end a newer capture session", async ({
  page,
}) => {
  const result = await exerciseRace(page, "stale-commands");
  expect(result.failures).toEqual([]);
  expect(result.startedSessions).toEqual([
    "abandoned-session",
    "current-session",
  ]);
  expect(result.acquisition).toBe(2);
  expect(result.streams).toBe(2);
  expect(result.contexts).toBe(2);
  expect(result.worklets).toBe(2);
  expect(result.staleCommandsPreservedCapture).toBe(true);
  expect(result.flushes).toBe(1);
  expect(result.acknowledged).toBe(1);
  expect(result.submissions).toHaveLength(1);
  expect(result.submissions[0].sessionId).toBe("current-session");
  expect(result.submissions[0].samples).toBeGreaterThan(0);
  expect(result.released).toBe(true);
});

test("a duplicate abandoned Cancel cannot invalidate a new Start reserved during pending permission", async ({
  page,
}) => {
  const result = await exerciseRace(page, "permission-stale-cancel");
  expect(result.failures).toEqual([]);
  expect(result.startedSessions).toEqual(["current-session"]);
  expect(result.acquisition).toBe(2);
  expect(result.streams).toBe(2);
  expect(result.contexts).toBe(1);
  expect(result.worklets).toBe(1);
  expect(result.abandonedPermissionTrackEnded).toBe(true);
  expect(result.submissions).toHaveLength(1);
  expect(result.submissions[0].sessionId).toBe("current-session");
  expect(result.submissions[0].samples).toBeGreaterThan(0);
  expect(result.submissions[0].released).toBe(true);
  expect(result.released).toBe(true);
});
