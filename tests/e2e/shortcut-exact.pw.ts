import { expect, test } from "@playwright/test";

test("shortcut save and edit retain entered indentation, tabs and trailing newline", async ({
  page,
}) => {
  const block =
    "\n  npm install @scope/café --save-dev\n\t# Keep 🚀 and /My File.md\n";
  await page.addInitScript(() => {
    if (!localStorage.getItem("delulu-demo-settings"))
      localStorage.setItem(
        "delulu-demo-settings",
        JSON.stringify({ onboardingComplete: true, customWords: [] }),
      );
  });
  await page.goto("/");
  const openRules = async () => {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await page
      .getByRole("tab", { name: "Personalization", exact: true })
      .click();
    await page
      .getByRole("tab", { name: "Text shortcuts", exact: true })
      .click();
  };
  await openRules();
  await page.getByRole("button", { name: "Add shortcut", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Trigger phrase" })
    .fill("my command");
  const output = page.getByRole("textbox", { name: "Expanded output" });
  await output.fill(" \n\t ");
  await expect(
    page.getByRole("button", { name: "Save rule", exact: true }),
  ).toBeDisabled();
  await output.fill(block);
  await page
    .getByRole("textbox", { name: "Test phrase" })
    .fill("Use my command");
  expect(await page.getByLabel("Rule preview").textContent()).toBe(
    "Use " + block,
  );
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("delulu-demo-settings")!).customWords[0]
          .replacement,
    ),
  ).toBe(block);
  await page.reload();
  await openRules();
  await page
    .getByRole("button", { name: "Edit my command", exact: true })
    .click();
  await expect(output).toHaveValue(block);
  const edited = block + "  echo café\t\n";
  await output.fill(edited);
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.reload();
  await openRules();
  await page
    .getByRole("button", { name: "Edit my command", exact: true })
    .click();
  await expect(output).toHaveValue(edited);
});
