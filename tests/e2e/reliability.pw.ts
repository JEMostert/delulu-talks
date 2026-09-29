import { expect, test, type Page } from "@playwright/test";

// Exercise the renderer with desktop-shaped asynchronous failures and events.
// Inference is deliberately outside this browser contract test.
async function scenario(page: Page, kind: string) {
  await page.addInitScript((kind) => {
    const state = { failSettings: true, stops: 0 };
    Object.assign(window, { __deluluScenario: state });
    const listeners = new Set<(value: unknown) => void>();
    Object.assign(window, {
      delulu: new Proxy(
        {},
        {
          get(_target, property: string) {
            if (property.startsWith("on"))
              return (callback: (value: unknown) => void) => {
                if (property === "onStatus") listeners.add(callback);
                return () => listeners.delete(callback);
              };
            if (property === "toggleDictation")
              return async () => {
                state.stops += 1;
                listeners.forEach((callback) =>
                  callback({
                    phase: "idle",
                    engine: "ready",
                    message: "Stopped",
                  }),
                );
              };
            return async (...args: unknown[]) => {
              if (
                kind === "settings-failure" &&
                property === "getSettings" &&
                state.failSettings
              )
                throw new Error("Settings temporarily unavailable");
              if (kind === "update-failure" && property === "getUpdateStatus")
                throw new Error("Update service unavailable");
              const { previewApi } = await import(
                /* @vite-ignore */ "/src/preview.ts"
              );
              if (kind === "recording" && property === "getStatus")
                return {
                  phase: "listening",
                  engine: "ready",
                  message: "Listening",
                  model: "r2t2",
                };
              if (kind === "mac" && property === "getSettings")
                return {
                  ...(await previewApi.getSettings()),
                  model: "r2t2Mlx",
                  language: "nl",
                };
              if (kind === "mac" && property === "getCapabilities")
                return {
                  ...(await previewApi.getCapabilities()),
                  platform: "darwin",
                  wayland: false,
                };
              if (kind === "search" && property === "getHistory")
                return [
                  {
                    ...(await previewApi
                      .getHistory()
                      .then((items) => items[0])),
                    text: "Recognized words",
                    magicText: null,
                    personalizedText: "Nyra uniquely personalized",
                  },
                ];
              const method = previewApi[
                property as keyof typeof previewApi
              ] as (...args: unknown[]) => unknown;
              return method.apply(previewApi, args);
            };
          },
        },
      ),
    });
    localStorage.setItem(
      "delulu-demo-settings",
      JSON.stringify({ onboardingComplete: true }),
    );
  }, kind);
  await page.goto("/");
}

test("an unavailable updater does not block the workspace", async ({
  page,
}) => {
  await scenario(page, "update-failure");
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toBeEnabled();
});

test("essential startup failures offer a working retry", async ({ page }) => {
  await scenario(page, "settings-failure");
  await expect(page.getByRole("alert")).toContainText(
    "Settings temporarily unavailable",
  );
  await page.evaluate(() => {
    (
      window as unknown as { __deluluScenario: { failSettings: boolean } }
    ).__deluluScenario.failSettings = false;
  });
  await page.getByRole("button", { name: "Retry opening workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
});

test("the main recording control remains usable while listening", async ({
  page,
}) => {
  await scenario(page, "recording");
  const stop = page.getByRole("button", {
    name: "Stop dictation",
    exact: true,
  });
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __deluluScenario: { stops: number } })
          .__deluluScenario.stops,
    ),
  ).toBe(1);
});

test("Mac R2T2 keeps explicit language selection", async ({ page }) => {
  await scenario(page, "mac");
  await expect(
    page.getByRole("combobox", { name: "Dictation language" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("combobox", { name: "Dictation language" }),
  ).toHaveValue("nl");
});

test("history finds personalized text absent from the original speech", async ({
  page,
}) => {
  await scenario(page, "search");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "History", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search transcript history" })
    .fill("uniquely personalized");
  await expect(
    page
      .locator(".transcript-preview")
      .getByText("Nyra uniquely personalized", { exact: true }),
  ).toBeVisible();
});
