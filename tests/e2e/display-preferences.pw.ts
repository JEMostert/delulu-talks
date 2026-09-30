import { expect, test } from "@playwright/test";

for (const scale of [1, 1.25, 1.5]) {
  test.describe(`display fixture at ${scale} device scale`, () => {
    test.use({ deviceScaleFactor: scale, viewport: { width: 540, height: 760 }, reducedMotion: "reduce" });
    test("compact capture and keyboard model navigation with larger controls", async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("delulu-demo-settings", JSON.stringify({ onboardingComplete: true }));
        Object.assign(window, { delulu: new Proxy({}, {
          get(_target, method: string) {
            if (method.startsWith("on")) return () => () => {};
            return async (...args: unknown[]) => {
              if (method === "getStatus") return { phase: "listening", engine: "ready", message: "Display fixture — no microphone capture" };
              const { previewApi } = await import(/* @vite-ignore */ "/src/preview.ts");
              const action = previewApi[method as keyof typeof previewApi] as (...values: unknown[]) => unknown;
              return action.apply(previewApi, args);
            };
          },
        }) });
      });
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Stop dictation", exact: true })).toBeVisible();
      // Browser text magnification fixture, not evidence of native OS text scaling.
      await page.addStyleTag({ content: "body { font-size: 18px; } button, input, select, textarea { font-size: inherit !important; }" });
      const stop = page.getByRole("button", { name: "Stop dictation", exact: true });
      await expect(stop).toBeEnabled();
      expect(await stop.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
      const overflow = () => page.locator("#page-content").evaluate((element) => element.scrollWidth > element.clientWidth + 1);
      expect(await overflow()).toBe(false);
      await page.keyboard.press("Control+Shift+P");
      await expect(page.getByRole("combobox", { name: "Find a command" })).toBeFocused();
      await page.getByRole("combobox", { name: "Find a command" }).fill("open model management");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
      expect(await overflow()).toBe(false);
    });
  });
}
