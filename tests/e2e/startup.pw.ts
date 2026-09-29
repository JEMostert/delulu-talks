import { expect, test, type Page } from "@playwright/test";

async function openStartup(page: Page, hung: string[]) {
  await page.clock.install();
  await page.addInitScript((hung) => {
    const calls: string[] = [];
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const pending = new Map<string, (value: unknown) => void>();
    Object.assign(window, {
      __startup: {
        calls,
        release: (method: string, value: unknown) =>
          pending.get(method)?.(value),
        emit: (event: string, value: unknown) =>
          listeners.get(event)?.forEach((receive) => receive(value)),
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
              return (receive: (value: unknown) => void) => {
                const callbacks = listeners.get(method) ?? new Set();
                listeners.set(method, callbacks);
                callbacks.add(receive);
                return () => callbacks.delete(receive);
              };
            return async (...args: unknown[]) => {
              const first = !calls.includes(method);
              calls.push(method);
              if (first && hung.includes(method))
                return new Promise((resolve) => pending.set(method, resolve));
              const { previewApi } = await import(
                /* @vite-ignore */ "/src/preview.ts"
              );
              const action = previewApi[method as keyof typeof previewApi] as (
                ...args: unknown[]
              ) => unknown;
              return action.apply(previewApi, args);
            };
          },
        },
      ),
    });
  }, hung);
  await page.goto("/");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __startup: { calls: string[] } }
          ).__startup.calls.filter((name) => name.startsWith("get")).length,
      ),
    )
    .toBe(7);
}

test("hung optional services reach a usable workspace at the startup deadline", async ({
  page,
}) => {
  await openStartup(page, [
    "getMagicStatus",
    "getShortcutStatus",
    "getCapabilities",
    "getUpdateStatus",
  ]);
  await expect(
    page.getByText("Opening your workspace…", { exact: true }).last(),
  ).toBeVisible();
  await page.clock.fastForward(8_001);
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toBeEnabled();
});

for (const method of ["getSettings", "getHistory"]) {
  test(`hung ${method} offers retry and late old replies cannot replace the new workspace`, async ({
    page,
  }) => {
    await openStartup(page, [method]);
    await page.clock.fastForward(8_001);
    await expect(page.getByRole("alert")).toContainText(
      `Timed out reading ${method === "getSettings" ? "settings" : "transcript history"}`,
    );
    await page.getByRole("button", { name: "Retry opening workspace" }).click();
    await expect(
      page.getByRole("heading", { name: "Controls", exact: true }),
    ).toBeVisible();
    await page.evaluate(
      ({ method }) => {
        (
          window as unknown as {
            __startup: { release: (method: string, value: unknown) => void };
          }
        ).__startup.release(
          method,
          method === "getSettings"
            ? { language: "de", onboardingComplete: false }
            : [],
        );
      },
      { method },
    );
    await expect(
      page.getByRole("heading", { name: "Controls", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Dictation language" }),
    ).toHaveValue("en");
    await expect(
      page.getByRole("button", { name: "Rewrite", exact: true }),
    ).toBeVisible();
  });
}

test("a current status event survives a timed-out initial status snapshot", async ({
  page,
}) => {
  await openStartup(page, ["getStatus"]);
  await page.evaluate(() => {
    (
      window as unknown as {
        __startup: { emit: (event: string, value: unknown) => void };
      }
    ).__startup.emit("onStatus", {
      phase: "listening",
      engine: "ready",
      message: "New speech event",
    });
  });
  await page.clock.fastForward(8_001);
  await expect(
    page.getByRole("button", { name: "Stop dictation", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (
      window as unknown as {
        __startup: { release: (method: string, value: unknown) => void };
      }
    ).__startup.release("getStatus", {
      phase: "idle",
      engine: "unloaded",
      message: "Old snapshot",
    });
  });
  await expect(
    page.getByRole("button", { name: "Stop dictation", exact: true }),
  ).toBeEnabled();
});
