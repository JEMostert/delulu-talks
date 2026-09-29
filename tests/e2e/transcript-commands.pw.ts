import { expect, test } from "@playwright/test";

test("Controls and History share rewrite apply/undo while preserving original speech", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("delulu-demo-settings"))
      localStorage.setItem(
        "delulu-demo-settings",
        JSON.stringify({ onboardingComplete: true }),
      );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  const original = await page
    .locator(".transcript-original:visible")
    .textContent();
  expect(original?.trim()).toBeTruthy();
  await page.evaluate(async () => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    bridge.rewriteMagic = async (request: { text: string }) => ({
      text: "Shared preview across Controls and History.",
      model: "qwen35Medium",
      processingTimeMs: 10,
      inputCharacters: request.text.length,
      outputCharacters: 43,
      includedInferences: false,
    });
  });
  // Refresh the shared actions after installing the explicit inference fixture.
  await page.getByRole("button", { name: "Switch color theme" }).click();
  await page.getByRole("button", { name: "Rewrite", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Rewrite source" }),
  ).toHaveValue(original ?? "");
  await page
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .click();
  await expect(page.locator(".transcript-original:visible")).toHaveText(
    "Shared preview across Controls and History.",
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "History", exact: true })
    .click();
  await expect(page.locator(".transcript-preview:visible")).toHaveText(
    "Shared preview across Controls and History.",
  );
  await page
    .getByRole("button", { name: "Review transcript", exact: true })
    .click();
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  await expect(page.locator(".transcript-original:visible")).toHaveText(
    original ?? "",
  );
  await page.getByRole("button", { name: "Undo rewrite", exact: true }).click();
  await expect(page.locator(".transcript-preview:visible")).toHaveText(
    original ?? "",
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Controls", exact: true })
    .click();
  await expect(page.locator(".transcript-original:visible")).toHaveText(
    original ?? "",
  );
  await expect(
    page.getByRole("button", { name: "Undo rewrite", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Rewrite after dictation", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
});
