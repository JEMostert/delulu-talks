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
        "Wordbook",
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

test("Wordbook adds, edits, persists and removes a voice snippet", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Wordbook", exact: true }).click();
  await page.getByRole("button", { name: "Add a word" }).click();
  await page.getByRole("textbox", { name: "Correct word" }).fill("signoff");
  await page
    .getByRole("textbox", { name: "Expanded output" })
    .fill("Thanks for your time!");
  await page.getByRole("button", { name: "Save word", exact: true }).click();
  await expect(
    page.getByText("Thanks for your time!", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit signoff" }).click();
  await page
    .getByRole("textbox", { name: "Expanded output" })
    .fill("See you soon!");
  await page.getByRole("button", { name: "Save word", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Wordbook", exact: true }).click();
  await expect(page.getByText("See you soon!", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete signoff" }).click();
  await page.getByRole("button", { name: "Delete word", exact: true }).click();
  await expect(page.getByText("No saved words")).toBeVisible();
});

test("corrections preserve original speech and can be restored", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Clean", exact: true }).click();
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
  await page.getByRole("button", { name: "Wordbook", exact: true }).click();
  await page.getByRole("button", { name: "Add a word" }).click();
  for (let i = 0; i < 9; i++) await page.keyboard.press("Tab");
  expect(
    await page
      .locator("dialog")
      .evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a word" })).toBeFocused();
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
      ["combobox", "Speech model"],
      ["combobox", "Speech output"],
      ["combobox", "Version to deliver"],
      ["combobox", "Dictation writing style"],
      ["combobox", "Writing model"],
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

test("quick configuration persists and writing style stays independent of its enable switch", async ({
  page,
}) => {
  await page
    .getByRole("combobox", { name: "Dictation language", exact: true })
    .selectOption("fr");
  await page
    .getByRole("combobox", { name: "Speech model", exact: true })
    .selectOption("crisperTurbo");
  await page
    .getByRole("combobox", { name: "Version to deliver", exact: true })
    .selectOption("verbatim");
  await page
    .getByRole("combobox", { name: "Dictation writing style", exact: true })
    .selectOption("concise");
  await page
    .getByRole("switch", { name: "Rewrite after dictation", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", {
      name: "Dictation writing style",
      exact: true,
    }),
  ).toBeDisabled();
  for (const name of [
    "Paste automatically",
    "Copy to clipboard",
    "Save history",
  ]) {
    await page.getByRole("switch", { name, exact: true }).click();
    await expect(
      page.getByRole("switch", { name, exact: true }),
    ).toHaveAttribute("aria-checked", "false");
  }
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Dictation language", exact: true }),
  ).toHaveValue("fr");
  await expect(
    page.getByRole("combobox", { name: "Speech model", exact: true }),
  ).toHaveValue("crisperTurbo");
  await expect(
    page.getByRole("combobox", { name: "Version to deliver", exact: true }),
  ).toHaveValue("verbatim");
  await expect(
    page.getByRole("switch", { name: "Save history", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await page
    .getByRole("switch", { name: "Rewrite after dictation", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", {
      name: "Dictation writing style",
      exact: true,
    }),
  ).toHaveValue("concise");
  await expect(
    page.getByRole("combobox", {
      name: "Dictation writing style",
      exact: true,
    }),
  ).toBeEnabled();
});
