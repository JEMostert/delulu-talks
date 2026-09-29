import { expect, test } from "@playwright/test";

for (const failure of [false, true]) {
  test(`clear history ${failure ? "failure keeps records and allows retry" : "removes shared review references without changing settings"}`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        "delulu-demo-settings",
        JSON.stringify({ onboardingComplete: true, language: "nl" }),
      ),
    );
    await page.goto("/");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "History", exact: true })
      .click();
    const count = await page.locator(".transcript-preview").count();
    expect(count).toBeGreaterThan(0);
    if (failure)
      await page.evaluate(async () => {
        const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
        const clear = bridge.clearHistory;
        bridge.clearHistory = async () => {
          bridge.clearHistory = clear;
          throw new Error("Fixture deletion write failed");
        };
      });
    const confirm = async () => {
      await page
        .getByRole("button", { name: "Clear history", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Clear history", exact: true })
        .click();
    };
    await confirm();
    if (failure) {
      await expect(page.getByRole("alert")).toContainText(
        "Fixture deletion write failed",
      );
      await expect(page.locator(".transcript-preview")).toHaveCount(count);
      await confirm();
    }
    await expect(
      page.getByRole("heading", { name: "No transcripts yet" }),
    ).toBeVisible();
    await expect(page.locator(".transcript-preview")).toHaveCount(0);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Controls", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "No transcript yet" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Paste last", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Dictation language" }),
    ).toHaveValue("nl");
  });
}
