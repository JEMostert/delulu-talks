import { expect, test } from "@playwright/test";

const source = "Ik bel morgen Amsterdam.\nDon't change <script> or e\u0301én.";
const output = "Ik bel vandaag Rotterdam.\nDon't change <script> or e\u0301én.";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss setup" }).click();
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Correct transcript" }).fill(source);
  await page.getByRole("button", { name: "Save correction" }).click();
  await page.evaluate(async (text) => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    bridge.rewriteMagic = async (request: { text: string }) => ({
      text,
      model: "qwen35Medium",
      processingTimeMs: 1,
      inputCharacters: request.text.length,
      outputCharacters: text.length,
      includedInferences: false,
    });
  }, output);
  await page.getByRole("button", { name: "Switch color theme" }).click();
  await page.getByRole("button", { name: "Rewrite", exact: true }).click();
});

test("word changes are readable, keyboard reachable, update with edits, and apply/undo preserves source", async ({
  page,
}) => {
  const region = page.getByRole("region", {
    name: "Changes from current text",
  });
  await expect(region).toHaveCount(0);
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(region).toBeVisible();
  await expect(region.locator("del")).toHaveText(["morgen", "Amsterdam"]);
  await expect(region.locator("ins")).toHaveText(["vandaag", "Rotterdam"]);
  await expect(region).toContainText("Removed text: morgen");
  await expect(region).toContainText("Added text: vandaag");
  await expect(region.locator("script")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Rewrite source" }),
  ).toHaveValue(source);
  await page.getByRole("textbox", { name: "Rewrite preview" }).focus();
  const changes = page.getByLabel("Rewrite changes", { exact: true });
  for (let step = 0; step < 12; step++) {
    if (await changes.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press("Tab");
  }
  await expect(changes).toBeFocused();
  await page.getByRole("textbox", { name: "Rewrite preview" }).fill(source);
  await expect(region.getByRole("status")).toHaveText(
    "No changes from current text.",
  );
  await expect(region.locator("del, ins")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Rewrite preview" }).fill(output);
  await expect(region.locator("ins")).toHaveText(["vandaag", "Rotterdam"]);
  await page
    .getByRole("button", { name: "Use this rewrite", exact: true })
    .click();
  await expect(page.locator(".transcript-original")).toHaveText(output);
  await page.getByRole("button", { name: "Undo rewrite", exact: true }).click();
  await expect(page.locator(".transcript-original")).toHaveText(source);
});

test("comparison fits compact windows in both themes and clears after preset changes", async ({
  page,
}, testInfo) => {
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  const region = page.getByRole("region", {
    name: "Changes from current text",
  });
  await page.setViewportSize({ width: 860, height: 650 });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await region.scrollIntoViewIfNeeded();
    await expect(region).toBeVisible();
    expect(
      await page
        .getByRole("dialog")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await expect(region.locator("del").first()).toHaveCSS(
      "text-decoration-line",
      "line-through",
    );
    await expect(region.locator("ins").first()).toHaveCSS(
      "text-decoration-line",
      "underline",
    );
    await page.screenshot({
      path: testInfo.outputPath(`rewrite-diff-${theme}.png`),
    });
  }
  await page
    .getByRole("combobox", { name: "Rewrite style" })
    .selectOption("polish");
  await expect(region).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Rewrite source" }),
  ).toHaveValue(source);
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(region).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".transcript-original")).toHaveText(source);
});

test("large edits disclose the coarse comparison while retaining complete texts", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const longSource = "start " + "alpha ".repeat(4_000) + "end";
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Correct transcript" })
    .fill(longSource);
  await page.getByRole("button", { name: "Save correction" }).click();
  await page.getByRole("button", { name: "Rewrite", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  const longPreview = "start " + "beta ".repeat(4_000) + "end";
  await page
    .getByRole("textbox", { name: "Rewrite preview" })
    .fill(longPreview);
  const region = page.getByRole("region", {
    name: "Changes from current text",
  });
  await expect(region).toContainText("Large change:");
  await expect(
    page.getByRole("textbox", { name: "Rewrite source" }),
  ).toHaveValue(longSource);
  await expect(
    page.getByRole("textbox", { name: "Rewrite preview" }),
  ).toHaveValue(longPreview);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".transcript-original")).toHaveText(longSource);
});
