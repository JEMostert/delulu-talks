import { expect, test, type Page } from "@playwright/test";

// The preview supplies recording state; these checks exercise the real CSS,
// React lifecycle, and visibility subscriptions, without loading a speech model.
async function phase(
  page: Page,
  action:
    | "toggleDictation"
    | "pauseDictation"
    | "resumeDictation"
    | "cancelDictation",
) {
  await page.evaluate(async (method) => {
    const { previewApi } = await import(/* @vite-ignore */ "/src/preview.ts");
    await previewApi[method]();
  }, action);
}
async function oceanTimes(page: Page) {
  return page.locator("[data-ocean]").evaluate(async (ocean) => {
    const animations = ocean
      .getAnimations({ subtree: true })
      .filter((animation) => animation instanceof CSSAnimation);
    // CSS playState can change before the compositor commits its pending pause
    // or resume. Sample only after that transition has settled.
    await Promise.all(animations.map((animation) => animation.ready));
    return animations.map((animation) => ({
      state: animation.playState,
      time: Number(animation.currentTime),
    }));
  });
}
async function expectMoving(page: Page) {
  await expect(page.locator("[data-ocean]")).toHaveAttribute(
    "data-active",
    "true",
  );
  const before = await oceanTimes(page);
  expect(before.some((animation) => animation.state === "running")).toBe(true);
  // Runner load can delay a rendered frame beyond a fixed 250 ms sample.
  // Still require real timeline progress, including after recording resumes.
  await expect
    .poll(async () => {
      const after = await oceanTimes(page);
      return after.some(
        (animation, index) =>
          animation.state === "running" && animation.time > before[index].time,
      );
    })
    .toBe(true);
}
async function expectStill(page: Page) {
  await expect(page.locator("[data-ocean]")).toHaveAttribute(
    "data-active",
    "false",
  );
  const before = await oceanTimes(page);
  expect(before.length).toBeGreaterThan(0);
  expect(before.every((animation) => animation.state === "paused")).toBe(true);
  await page.waitForTimeout(250);
  expect(await oceanTimes(page)).toEqual(before);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute(
    "data-rendering",
    "hardware",
  );
});

test("ocean stays still in idle and pause, animates during recording, and stops after cancel", async ({
  page,
}) => {
  await expectStill(page);
  await phase(page, "toggleDictation");
  await expectMoving(page);
  await phase(page, "pauseDictation");
  await expectStill(page);
  await phase(page, "resumeDictation");
  await expectMoving(page);
  await phase(page, "cancelDictation");
  await expectStill(page);
});

test("hidden decoration stops without changing the recording phase", async ({
  page,
}) => {
  await phase(page, "toggleDictation");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expectStill(page);
  expect(
    await page.evaluate(async () => {
      const { previewApi } = await import(/* @vite-ignore */ "/src/preview.ts");
      return (await previewApi.getStatus()).phase;
    }),
  ).toBe("listening");
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("[data-ocean]")).toHaveAttribute(
    "data-active",
    "true",
  );
});

test("workspace scrolling keeps decoration paused and respects reduced motion", async ({
  page,
}) => {
  await phase(page, "toggleDictation");
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await expect(page.locator("[data-ocean]")).toHaveAttribute(
    "data-covered",
    "true",
  );
  await expectStill(page);
  expect(
    await page
      .locator(".sheet-content")
      .evaluate((element) => getComputedStyle(element).scrollBehavior),
  ).toBe("smooth");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".sheet-content")
      .evaluate((element) => getComputedStyle(element).scrollBehavior),
  ).toBe("auto");
});
