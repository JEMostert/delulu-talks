import { expect, test, type Page } from "@playwright/test";

async function openFailure(page: Page, failures: string[], delay = "") {
  await page.clock.install();
  await page.addInitScript(
    ({ failures, delay }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      const state = { failures, calls: [] as string[], removed: 0 };
      Object.assign(window, {
        __failure: {
          state,
          subscriptions: () =>
            Object.fromEntries(
              [...listeners].map(([event, callbacks]) => [
                event,
                callbacks.size,
              ]),
            ),
          emit: (event: string, value: unknown) =>
            listeners.get(event)?.forEach((callback) => callback(value)),
        },
      });
      localStorage.setItem(
        "delulu-demo-settings",
        JSON.stringify({ onboardingComplete: true }),
      );
      Object.assign(window, {
        delulu: new Proxy(
          {},
          {
            get(_target, method: string) {
              if (method.startsWith("on"))
                return (callback: (value: unknown) => void) => {
                  const callbacks = listeners.get(method) ?? new Set();
                  callbacks.add(callback);
                  listeners.set(method, callbacks);
                  return () => {
                    state.removed += 1;
                    callbacks.delete(callback);
                  };
                };
              return async (...args: unknown[]) => {
                state.calls.push(method);
                if (state.failures.includes(method))
                  throw new Error(`${method} temporarily unavailable`);
                if (method === delay)
                  await new Promise((resolve) => setTimeout(resolve, 4_000));
                const { previewApi } = await import(
                  /* @vite-ignore */ "/src/preview.ts"
                );
                const action = previewApi[
                  method as keyof typeof previewApi
                ] as (...args: unknown[]) => unknown;
                return action.apply(previewApi, args);
              };
            },
          },
        ),
      });
    },
    { failures, delay },
  );
  await page.goto("/");
}

for (const service of [
  "getStatus",
  "getMagicStatus",
  "getShortcutStatus",
  "getCapabilities",
  "getUpdateStatus",
]) {
  test(`${service} failure preserves essential workspace data and navigation`, async ({
    page,
  }) => {
    await openFailure(page, [service]);
    await expect(
      page.getByRole("heading", { name: "Controls", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Dictation language" }),
    ).toHaveValue("en");
    await expect(
      page.getByRole("button", { name: "Rewrite", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "History", exact: true })
      .click();
    await expect(page.locator(".transcript-preview").first()).toBeVisible();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Controls", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Start dictation", exact: true }),
    ).toBeEnabled();
    if (service === "getStatus")
      await expect(
        page
          .locator(".sidebar")
          .getByRole("button", { name: "Speech Error", exact: true }),
      ).toBeVisible();
    if (service === "getMagicStatus")
      await expect(
        page
          .locator(".sidebar")
          .getByRole("button", { name: "Rewriting Error", exact: true }),
      ).toBeVisible();
    if (service === "getShortcutStatus")
      await expect(
        page.getByText(
          "Shortcut status is unavailable. Use the Record button.",
          { exact: true },
        ),
      ).toBeVisible();
  });
}

test("a slow successful essential read opens with its real data before the deadline", async ({
  page,
}) => {
  await openFailure(page, [], "getHistory");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __failure: { state: { calls: string[] } } }
        ).__failure.state.calls.includes("getHistory"),
      ),
    )
    .toBe(true);
  await expect(
    page.getByText("Opening your workspace…", { exact: true }).last(),
  ).toBeVisible();
  await page.clock.fastForward(4_001);
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Rewrite", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry opening workspace" }),
  ).toHaveCount(0);
});

test("subscriptions recover speech and rewriting after their initial reads failed", async ({
  page,
}) => {
  await openFailure(page, ["getStatus", "getMagicStatus"]);
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: "Speech Error", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const api = (
      window as unknown as {
        __failure: { emit: (event: string, value: unknown) => void };
      }
    ).__failure;
    api.emit("onStatus", {
      phase: "listening",
      engine: "ready",
      message: "Recovered speech",
    });
    api.emit("onMagicStatus", {
      phase: "idle",
      engine: "ready",
      message: "Recovered rewriting",
    });
  });
  await expect(
    page.getByRole("button", { name: "Stop dictation", exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: "Rewriting Loaded", exact: true }),
  ).toBeVisible();
});

test("repeated failed retries dispose old subscriptions and one successful retry restores live events", async ({
  page,
}) => {
  await openFailure(page, ["getSettings"]);
  for (let retry = 0; retry < 3; retry += 1) {
    await expect(page.getByRole("alert")).toContainText(
      "getSettings temporarily unavailable",
    );
    await page.getByRole("button", { name: "Retry opening workspace" }).click();
  }
  await expect(page.getByRole("alert")).toContainText(
    "getSettings temporarily unavailable",
  );
  const before = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __failure: {
          state: { failures: string[]; removed: number };
          subscriptions: () => Record<string, number>;
        };
      }
    ).__failure;
    api.state.failures = [];
    return { listeners: api.subscriptions(), removed: api.state.removed };
  });
  expect(Object.values(before.listeners)).toEqual(Array(8).fill(1));
  expect(before.removed).toBeGreaterThanOrEqual(24);
  await page.getByRole("button", { name: "Retry opening workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
  const after = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __failure: {
          emit: (event: string, value: unknown) => void;
          subscriptions: () => Record<string, number>;
        };
      }
    ).__failure;
    api.emit("onStatus", {
      phase: "listening",
      engine: "ready",
      message: "One live subscriber",
    });
    return api.subscriptions();
  });
  expect(Object.values(after)).toEqual(Array(8).fill(1));
  await expect(
    page.getByRole("button", { name: "Stop dictation", exact: true }),
  ).toBeEnabled();
});
