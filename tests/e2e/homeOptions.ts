import type { Page } from "@playwright/test";

export async function openHomeOptions(page: Page) {
  const summary = page.getByText("Corrections, rewriting & delivery options", {
    exact: true,
  });
  const expanded = await summary
    .locator("..")
    .evaluate((element) => (element as HTMLDetailsElement).open);
  if (!expanded) await summary.click();
}
