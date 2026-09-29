import { expect, test } from "@playwright/test";

test("local data shows separate measurements, partial failures, missing runtimes and deliberate refresh", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "delulu-demo-settings",
      JSON.stringify({ onboardingComplete: true }),
    );
    let scans = 0;
    const state = { fail: true };
    Object.assign(window, { __inventoryState: state });
    Object.assign(window, {
      delulu: new Proxy(
        {},
        {
          get(_target, property: string) {
            if (property.startsWith("on")) return () => () => {};
            return async (...args: unknown[]) => {
              if (property === "getLocalDataOverview") {
                if (state.fail)
                  throw new Error("Inventory temporarily unavailable");
                scans += 1;
                return {
                  dataDirectory: "/private/delulu",
                  checkedAt: Date.now(),
                  categories: [
                    "History",
                    "Settings",
                    "Model cache",
                    "Runtimes",
                    "Temporary audio",
                  ].map((label, index) => ({
                    id: String(index),
                    label,
                    description: `Local ${label}`,
                    locations: [
                      {
                        path: `/private/delulu/${label}`,
                        status:
                          index === 3
                            ? "missing"
                            : index === 2
                              ? "partial"
                              : "present",
                        bytes: scans === 1 ? 2048 : 4096,
                        files: 1,
                        skippedLinks: index === 2 ? 2 : 0,
                        problems:
                          index === 2
                            ? ["/private/delulu/Model cache: EACCES"]
                            : [],
                      },
                    ],
                  })),
                };
              }
              const { previewApi } = await import(
                /* @vite-ignore */ "/src/preview.ts"
              );
              return (
                previewApi[property as keyof typeof previewApi] as (
                  ...args: unknown[]
                ) => unknown
              ).apply(previewApi, args);
            };
          },
        },
      ),
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("tab", { name: "Local data", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Inventory temporarily unavailable",
  );
  await page.evaluate(() => {
    (
      window as unknown as { __inventoryState: { fail: boolean } }
    ).__inventoryState.fail = false;
  });
  await page
    .getByRole("button", { name: "Refresh local data", exact: true })
    .click();
  const overview = page.getByRole("region", { name: "Local data overview" });
  for (const label of [
    "History",
    "Settings",
    "Model cache",
    "Runtimes",
    "Temporary audio",
  ])
    await expect(
      overview.getByRole("region", { name: label, exact: true }),
    ).toBeVisible();
  await expect(
    overview.getByRole("region", { name: "Model cache" }),
  ).toContainText("Partial scan · at least 2.0 KiB");
  await expect(
    overview.getByRole("region", { name: "Model cache" }),
  ).toContainText("2 links excluded");
  await expect(
    overview.getByRole("region", { name: "Runtimes" }),
  ).toContainText("Not present");
  await expect(
    overview.getByRole("region", { name: "Temporary audio" }),
  ).toContainText("2.0 KiB");
  await page
    .getByRole("button", { name: "Refresh local data", exact: true })
    .click();
  await expect(
    overview.getByRole("region", { name: "Temporary audio" }),
  ).toContainText("4.0 KiB");
  await expect(
    overview.getByRole("button", { name: /delete|remove|clear/i }),
  ).toHaveCount(0);
});

test("browser preview does not fabricate device inventory", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "delulu-demo-settings",
      JSON.stringify({ onboardingComplete: true }),
    ),
  );
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("tab", { name: "Local data", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "This action needs the installed desktop app",
  );
  await expect(
    page.getByRole("region", { name: "History", exact: true }),
  ).toHaveCount(0);
});
