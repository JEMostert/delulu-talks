import { expect, test, type Page } from "@playwright/test";

// Capture is native in the desktop app; the renderer only displays the state it
// receives. The browser preview pushes the same status and level events.
async function pushStatus(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (next) => {
    const { setPreviewStatus } = await import(
      /* @vite-ignore */ "/src/preview.ts"
    );
    setPreviewStatus(next);
  }, patch);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toBeEnabled();
});

test("recording controls follow the desktop status", async ({ page }) => {
  const clock = page.locator(".controller-status .recording-clock");
  const status = page.locator(".controller-status [role=status]");
  await expect(clock).toHaveCount(0);

  await page
    .getByRole("button", { name: "Start dictation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeVisible();
  await expect(clock).toHaveText(/^0:0\d$/);
  // The level meter moves with `onRecordingLevel`.
  await expect
    .poll(() =>
      page
        .locator(".audio-halo")
        .evaluate((halo) => Number(halo.style.getPropertyValue("--level"))),
    )
    .toBeGreaterThan(0);

  await pushStatus(page, { silenceCountdownSeconds: 3 });
  await expect(status).toHaveText("Silence detected — stopping in 3s");
  await pushStatus(page, {
    silenceCountdownSeconds: null,
    captureInputNotice: "The microphone was disconnected. Recording stopped.",
  });
  await expect(
    page.getByText("The microphone was disconnected. Recording stopped."),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Pause recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resume recording", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".audio-halo")).toHaveCount(0);
  const paused = await clock.textContent();
  await page.waitForTimeout(1_200);
  await expect(clock).toHaveText(paused ?? "");

  await page
    .getByRole("button", { name: "Resume recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause recording", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Cancel recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toBeVisible();
  await expect(clock).toHaveCount(0);
  await expect(status).toHaveText("Recording cancelled");
});

test("the microphone picker lists the desktop inputs", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const picker = page.getByRole("combobox", { name: "Microphone" }).first();
  await expect(picker.locator("option")).toHaveText([
    "System default",
    "USB Microphone",
    "Built-in Audio Analog Stereo",
  ]);
});

test("home stays quiet while ready and the dock opens history", async ({
  page,
}) => {
  await expect(page.locator(".controller-status [role=status]")).toHaveText("");
  await expect(page.locator(".engine-chip")).toHaveCount(0);

  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "History", level: 1 }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toBeFocused();
});
