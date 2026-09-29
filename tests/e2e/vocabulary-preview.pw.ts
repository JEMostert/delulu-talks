import { expect, test } from "@playwright/test";

test("saved rules preview explains actual winners without writing or changing history", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "delulu-demo-settings",
      JSON.stringify({
        onboardingComplete: true,
        customWords: [
          {
            id: "correction",
            kind: "correction",
            term: "Delulu",
            soundsLike: "the lulu, de loo loo",
            replacement: "",
            enabled: true,
          },
          {
            id: "short",
            kind: "correction",
            term: "Short",
            soundsLike: "the",
            replacement: "",
            enabled: true,
          },
          {
            id: "shortcut",
            kind: "shortcut",
            term: "my signature",
            soundsLike: "sign off",
            replacement: "Fixture Person\nExact $100 $(literal)",
            enabled: true,
          },
          {
            id: "disabled",
            kind: "correction",
            term: "Ignored",
            soundsLike: "mistake",
            replacement: "",
            enabled: false,
          },
        ],
      }),
    );
  });
  await page.goto("/");
  const before = await page.evaluate(async () => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    const save = bridge.updateSettings;
    Object.assign(window, { __previewSaves: 0 });
    bridge.updateSettings = async (...args) => {
      (window as unknown as { __previewSaves: number }).__previewSaves++;
      return save(...args);
    };
    return {
      settings: await bridge.getSettings(),
      history: await bridge.getHistory(),
    };
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByRole("tab", { name: "Personalization", exact: true }).click();
  const phrase = "THE LULU: sign off; mistake.";
  await page.getByRole("textbox", { name: "Test saved rules" }).fill(phrase);
  await expect(
    page.getByLabel("Original test phrase", { exact: true }),
  ).toHaveText(phrase);
  await expect(
    page.getByLabel("Saved rules result", { exact: true }),
  ).toHaveText("Delulu: Fixture Person\nExact $100 $(literal); mistake.");
  const matches = page.getByRole("list", { name: "Matched saved rules" });
  await expect(matches.getByRole("listitem")).toHaveCount(2);
  await expect(matches).toContainText(
    "Matched “THE LULU” · trigger “the lulu”",
  );
  await expect(matches).toContainText(
    "Matched “sign off” · trigger “sign off”",
  );
  await expect(matches).not.toContainText("Short");
  await expect(matches).not.toContainText("Ignored");
  for (const width of [540, 860, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByLabel("Original test phrase", { exact: true }),
    ).toHaveText(phrase);
    await expect(matches.getByRole("listitem")).toHaveCount(2);
  }
  const after = await page.evaluate(async () => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    return {
      settings: await bridge.getSettings(),
      history: await bridge.getHistory(),
      saves: (window as unknown as { __previewSaves: number }).__previewSaves,
    };
  });
  expect(after.settings).toEqual(before.settings);
  expect(after.history).toEqual(before.history);
  expect(after.saves).toBe(0);

  // Persisting an explicit rule toggle updates the preview with the same input.
  await page.getByRole("switch", { name: "Enable Delulu" }).click();
  await expect(
    page.getByLabel("Saved rules result", { exact: true }),
  ).toHaveText("Short LULU: Fixture Person\nExact $100 $(literal); mistake.");
  await expect(matches).toContainText("Short");
  await expect(matches).not.toContainText("Delulu");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __previewSaves: number }).__previewSaves,
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "Edit Short" }).click();
  await page
    .getByRole("textbox", { name: "Replace with", exact: true })
    .fill("Updated");
  await page.getByRole("button", { name: "Save rule", exact: true }).click();
  await expect(
    page.getByLabel("Saved rules result", { exact: true }),
  ).toHaveText("Updated LULU: Fixture Person\nExact $100 $(literal); mistake.");
  await expect(
    page.getByLabel("Original test phrase", { exact: true }),
  ).toHaveText(phrase);
  const history = await page.evaluate(async () => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    return bridge.getHistory();
  });
  expect(history).toEqual(before.history);
  await page
    .getByRole("textbox", { name: "Test saved rules" })
    .fill("No matching rule here");
  await expect(
    page.getByText("No enabled rules matched this phrase.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Saved rules result", { exact: true }),
  ).toHaveText("No matching rule here");
});
