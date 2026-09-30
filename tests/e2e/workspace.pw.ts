import { identifySyntheticMicrophone } from "./syntheticMicrophone";
import { openHomeOptions } from "./homeOptions";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await identifySyntheticMicrophone(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss setup" }).click();
  await openHomeOptions(page);
});

test("all pages fit desktop and compact windows in both themes", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Application", exact: true }).click();
    await page.getByRole("button", { name: theme, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const width of [1280, 860]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of [
        "Controls",
        "History",
        "Audio files",
        "Models",
        "Settings",
      ]) {
        await page
          .getByRole("navigation")
          .getByRole("button", { name, exact: true })
          .click();
        await expect(page.locator("main h1")).toBeVisible();
        expect(
          await page
            .locator(".page-scroll")
            .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        if (width === 1280 && name === "Controls") {
          await page.screenshot({
            path: testInfo.outputPath(`controls-${theme}.png`),
          });
        }
      }
    }
  }
  expect(errors).toEqual([]);
});

test("rewriting lives beside transcripts and model setup stays accessible", async ({
  page,
}) => {
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "Writing", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Rewrite", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Rewrite transcript" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rewrite source" }),
  ).not.toBeEmpty();
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Models", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Rewrite where your text is" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Local rewrite model" }),
  ).toBeVisible();
});

test("text shortcuts can be previewed, edited, persisted and removed", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Personalization", exact: true }).click();
  await page.getByRole("tab", { name: "Text shortcuts", exact: true }).click();
  await page.getByRole("button", { name: "Add shortcut" }).click();
  await page.getByRole("textbox", { name: "Trigger phrase" }).fill("signoff");
  await page
    .getByRole("textbox", { name: "Expanded output" })
    .fill("Thanks for your time!");
  await page
    .getByRole("textbox", { name: "Test phrase" })
    .fill("Here is my signoff");
  await expect(page.getByLabel("Rule preview")).toHaveText(
    "Here is my Thanks for your time!",
  );
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await page.getByRole("button", { name: "Edit signoff" }).click();
  await page
    .getByRole("textbox", { name: "Expanded output" })
    .fill("See you soon!");
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await page.reload();
  await openHomeOptions(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Personalization", exact: true }).click();
  await page.getByRole("tab", { name: "Text shortcuts", exact: true }).click();
  await expect(page.getByText("See you soon!", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete signoff" }).click();
  await page.getByRole("button", { name: "Delete rule", exact: true }).click();
  await expect(page.getByText("No text shortcuts yet")).toBeVisible();
});

test("corrections preserve original speech and can be restored", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Correct transcript" })
    .fill("My corrected transcript.");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(
    page.getByText("My corrected transcript.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByText("My corrected transcript.", { exact: true }),
  ).toHaveCount(0);
});

test("modal contains focus and closes with Escape without saving", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Personalization", exact: true }).click();
  await page.getByRole("button", { name: "Add correction" }).click();
  for (let i = 0; i < 9; i++) await page.keyboard.press("Tab");
  expect(
    await page
      .locator("dialog")
      .evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add correction" }),
  ).toBeFocused();
});

test("preview explicitly reports unavailable native operations", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Start dictation", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("installed desktop app");
  await page.getByRole("button", { name: "Dismiss message" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("microphone capture produces PCM WAV and releases the input", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["microphone"]);
  const result = await page.evaluate(async () => {
    // Exercise the real browser recorder with Chromium's synthetic microphone.
    const { PcmRecorder } = await import(/* @vite-ignore */ "/src/recorder.ts");
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    let wav = new Uint8Array();
    const failures: string[] = [];
    bridge.recordingStarted = async () => {};
    bridge.recordingFailed = async (message: string) => {
      failures.push(message);
    };
    bridge.submitRecording = async (value: { wav: Uint8Array }) => {
      wav = value.wav;
    };
    const recorder = new PcmRecorder();
    await recorder.handle({
      action: "start",
      inputDeviceId: "fixture-microphone",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await recorder.handle({
      action: "stop",
      inputDeviceId: "fixture-microphone",
    });
    return {
      header: String.fromCharCode(...wav.slice(0, 4)),
      bytes: wav.length,
      sampleRate:
        wav.length >= 44 ? new DataView(wav.buffer).getUint32(24, true) : 0,
      failures,
    };
  });
  expect(result.failures).toEqual([]);
  expect(result.header).toBe("RIFF");
  expect(result.sampleRate).toBe(16000);
  expect(result.bytes).toBeGreaterThan(44);
});

test("cancelling while microphone permission is pending releases the eventual stream", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["microphone"]);
  const result = await page.evaluate(async () => {
    const { PcmRecorder } = await import(/* @vite-ignore */ "/src/recorder.ts");
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let stream: MediaStream | null = null;
    let started = 0;
    bridge.recordingStarted = async () => {
      started += 1;
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      stream = await getUserMedia(constraints);
      return stream;
    };
    const recorder = new PcmRecorder();
    const start = recorder.handle({
      action: "start",
      inputDeviceId: "fixture-microphone",
    });
    await pending;
    const cancel = recorder.cancel();
    release();
    await Promise.all([start, cancel]);
    // Cancellation returns before an unabortable permission request settles.
    // Observe the eventual stream cleanup instead of assuming it is synchronous.
    const cleanupDeadline = performance.now() + 5000;
    while (
      !(stream as MediaStream | null)
        ?.getTracks()
        .every((track) => track.readyState === "ended") &&
      performance.now() < cleanupDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    navigator.mediaDevices.getUserMedia = getUserMedia;
    return {
      started,
      ended: (stream as MediaStream | null)
        ?.getTracks()
        .every((track) => track.readyState === "ended"),
    };
  });
  expect(result).toEqual({ started: 0, ended: true });
});

test("startup exposes priority settings above the fold in compact and desktop windows", async ({
  page,
}) => {
  for (const width of [1280, 860]) {
    await page.setViewportSize({ width, height: 650 });
    for (const [role, name] of [
      ["combobox", "Dictation language"],
      ["button", "Start dictation"],
      ["button", "Settings"],
    ] as const) {
      const control = page.getByRole(role, { name, exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${name} has a layout box`).not.toBeNull();
      expect(box!.y, `${name} starts in the viewport`).toBeGreaterThanOrEqual(
        0,
      );
      expect(
        box!.y + box!.height,
        `${name} fits at ${width} × 650`,
      ).toBeLessThanOrEqual(650);
    }
  }
  await expect(page.getByText("Less typing.", { exact: false })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toHaveCount(1);
});

test("native dictation defaults persist across reloads", async ({ page }) => {
  await expect(
    page.getByRole("switch", { name: "Rewrite after dictation", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await page
    .getByRole("combobox", { name: "Dictation language", exact: true })
    .selectOption("fr");
  await page.reload();
  await openHomeOptions(page);
  await expect(
    page.getByRole("combobox", { name: "Dictation language", exact: true }),
  ).toHaveValue("fr");
  await expect(
    page.getByRole("switch", { name: "Rewrite after dictation", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
});

test("a transcript edit suggests an explicit correction rule and rejects conflicting triggers", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  const original = await page.locator(".transcript-original").textContent();
  const firstWord = original!.split(" ")[0];
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Correct transcript" })
    .fill(original!.replace(firstWord, "Delulu"));
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await page.getByRole("button", { name: "Review rule", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Recognized text", exact: true }),
  ).toHaveValue(firstWord);
  await page
    .getByRole("button", { name: "Save correction rule", exact: true })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Personalization", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Delulu en", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add correction" }).click();
  await page
    .getByRole("textbox", { name: "Recognized text", exact: true })
    .fill(firstWord);
  await page
    .getByRole("textbox", { name: "Replace with", exact: true })
    .fill("Another");
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "already used",
  );
  await expect(
    page.getByRole("button", { name: "Save rule", exact: true }),
  ).toBeDisabled();
});

test("manual rewrite previews, applies and undoes while automatic rewriting stays off", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    bridge.rewriteMagic = async (request: { text: string }) => ({
      text: "A deliberately shorter draft.",
      model: "qwen35Medium",
      processingTimeMs: 10,
      inputCharacters: request.text.length,
      outputCharacters: 29,
      includedInferences: false,
    });
  });
  // Re-render actions with the test inference stub; production preview never pretends to infer.
  await page.getByRole("button", { name: "Switch color theme" }).click();
  await page.getByRole("button", { name: "Rewrite", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Rewrite preview" }),
  ).toHaveValue("A deliberately shorter draft.");
  await page
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .click();
  await expect(page.locator(".transcript-original")).toHaveText(
    "A deliberately shorter draft.",
  );
  await page.getByRole("button", { name: "Undo rewrite", exact: true }).click();
  await expect(page.locator(".transcript-original")).not.toHaveText(
    "A deliberately shorter draft.",
  );
  await expect(
    page.getByRole("switch", { name: "Rewrite after dictation", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
});

test("rewrite failure preserves source and exposes a retryable error", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    bridge.rewriteMagic = async () => {
      throw new Error("Writing model stopped unexpectedly.");
    };
  });
  await page.getByRole("button", { name: "Switch color theme" }).click();
  const original = await page.locator(".transcript-original").textContent();
  await page.getByRole("button", { name: "Rewrite", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Writing model stopped unexpectedly",
  );
  await expect(
    page.getByRole("button", { name: "Generate preview", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".transcript-original")).toHaveText(original!);
});

test("queued imported recordings use the shared correction and rewrite review", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    let chosen = false;
    let completed = false;
    let version = 0;
    const queue = () => ({
      version,
      paused: !completed,
      jobs: chosen
        ? [
            {
              id: "fixture-job",
              path: "/fixture.wav",
              name: "fixture.wav",
              size: 1024,
              state: completed ? "completed" : "queued",
              error: null,
              transcriptId: completed ? "imported-fixture" : null,
            },
          ]
        : [],
    });
    const emit = (name: string, value: unknown) =>
      listeners.get(name)?.forEach((callback) => callback(value));
    Object.assign(window, {
      delulu: new Proxy(
        {},
        {
          get(_target, name: string) {
            if (name.startsWith("on"))
              return (callback: (value: unknown) => void) => {
                const set = listeners.get(name) ?? new Set();
                set.add(callback);
                listeners.set(name, set);
                return () => set.delete(callback);
              };
            return async (...args: unknown[]) => {
              const { previewApi } = await import(
                /* @vite-ignore */ "/src/preview.ts"
              );
              if (name === "getImportQueue") return queue();
              if (name === "getAudioJobs")
                return chosen
                  ? [
                      {
                        path: "/fixture.wav",
                        name: "fixture.wav",
                        size: 1024,
                        state: completed ? "done" : "pending",
                        queueId: "fixture-job",
                        createdAt: 1,
                        updatedAt: version,
                        resultId: completed ? "imported-fixture" : undefined,
                        sourceAvailable: true,
                      },
                    ]
                  : [];
              if (name === "chooseAudioFiles") {
                chosen = true;
                version++;
                emit("onImportQueue", queue());
                return [];
              }
              if (name === "pauseImportQueue") {
                completed = true;
                version++;
                emit("onTranscript", {
                  ...(await previewApi.getHistory())[0],
                  id: "imported-fixture",
                  source: "file",
                  sourceName: "fixture.wav",
                  magicText: null,
                });
                emit("onImportQueue", queue());
                return queue();
              }
              if (name === "inspectAudioFile")
                return {
                  durationSeconds: 1,
                  channels: 1,
                  sampleRate: 16000,
                  decoder: "soundfile",
                  decoderReady: true,
                  decoderDetail: "Fixture decoder readiness",
                  estimatedPcmBytes: 64000,
                  processingTimeEstimate: "Not measured",
                };
              const method = previewApi[name as keyof typeof previewApi] as (
                ...values: unknown[]
              ) => unknown;
              return method.apply(previewApi, args);
            };
          },
        },
      ),
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "Audio files", exact: true }).click();
  await page
    .getByRole("button", { name: /Choose or drop audio and video/ })
    .click();
  await page.getByRole("button", { name: "Resume queue", exact: true }).click();
  await page.getByRole("button", { name: /fixture.wav · done/ }).click();
  const review = page.locator("section").filter({
    has: page.getByRole("heading", { name: "fixture.wav", exact: true }),
  });
  await review
    .getByRole("button", { name: "Review transcript", exact: true })
    .click();
  await expect(
    review.getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Rewrite", exact: true }),
  ).toBeVisible();
});
