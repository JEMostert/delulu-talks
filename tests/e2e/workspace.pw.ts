import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss setup" }).click();
});

test("all pages fit desktop and compact windows in both themes", async ({
  page,
}) => {
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
        "Writing",
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
      }
    }
  }
  expect(errors).toEqual([]);
});

test("Magic drafts survive navigation and can be cleared", async ({ page }) => {
  await page.getByRole("button", { name: "Writing", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Text to rewrite" })
    .fill("Please keep my draft while I check settings.");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Writing", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Text to rewrite" }),
  ).toHaveValue("Please keep my draft while I check settings.");
  await page.getByRole("button", { name: "Clear source", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Text to rewrite" }),
  ).toBeEmpty();
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
    .getByRole("button", { name: "Start recording", exact: true })
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
    await recorder.handle({ action: "start", inputDeviceId: "default" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await recorder.handle({ action: "stop", inputDeviceId: "default" });
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
      inputDeviceId: "default",
    });
    await pending;
    const cancel = recorder.cancel();
    release();
    await Promise.all([start, cancel]);
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
      ["combobox", "Microphone"],
      ["combobox", "Dictation language"],
      ["combobox", "Recording gesture"],
      ["switch", "Rewrite after dictation"],
      ["switch", "Paste automatically"],
      ["switch", "Copy to clipboard"],
      ["switch", "Save history"],
      ["button", "Start recording"],
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
  await expect(page.locator(".record-command")).toHaveCount(1);
});

test("native dictation defaults persist across reloads", async ({ page }) => {
  await expect(
    page.getByRole("switch", { name: "Rewrite after dictation", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await page
    .getByRole("combobox", { name: "Dictation language", exact: true })
    .selectOption("fr");
  await page.reload();
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
    page.getByRole("heading", { name: "Delulu", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add correction" }).click();
  await page
    .getByRole("textbox", { name: "Recognized text", exact: true })
    .fill(firstWord);
  await page
    .getByRole("textbox", { name: "Replace with", exact: true })
    .fill("Another");
  await expect(page.getByRole("alert")).toContainText("already used");
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

test("imported recordings use the shared correction and rewrite review", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    bridge.chooseAudioFile = async () => ({
      path: "/fixture.wav",
      name: "fixture.wav",
      size: 1024,
    });
    bridge.runLab = async () => ({
      ...(await bridge.getHistory())[0],
      id: "imported-fixture",
      source: "file",
      sourceName: "fixture.wav",
      magicText: null,
    });
  });
  await page.getByRole("button", { name: "Audio files", exact: true }).click();
  await page.getByRole("button", { name: /Choose audio or video/ }).click();
  await page.locator(".lab-run").click();
  await expect(
    page.locator(".lab-result").getByText("fixture.wav", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".lab-result")
      .getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".lab-result")
      .getByRole("button", { name: "Rewrite", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".lab-result")
      .getByRole("button", { name: "Remember correction", exact: true }),
  ).toBeVisible();
});
