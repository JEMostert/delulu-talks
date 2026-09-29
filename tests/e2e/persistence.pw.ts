import { expect, test, type Page } from "@playwright/test";

async function failWrites(page: Page, method: string) {
  await page.addInitScript((method) => {
    const state = { fail: true };
    Object.assign(window, { __persistence: state });
    localStorage.setItem(
      "delulu-demo-settings",
      JSON.stringify({ onboardingComplete: true, theme: "light" }),
    );
    Object.assign(window, {
      delulu: new Proxy(
        {},
        {
          get(_target, name: string) {
            if (name.startsWith("on")) return () => () => {};
            return async (...args: unknown[]) => {
              if (name === method && state.fail)
                throw new Error(
                  "Local data write failed — fixture disk unavailable",
                );
              if (name === "rewriteMagic")
                return {
                  text: "Fixture rewrite awaiting an explicit saved apply.",
                  model: "qwen35Medium",
                  preset: "concise",
                  processingTimeMs: 1,
                  inputCharacters: 100,
                  outputCharacters: 50,
                  includedInferences: false,
                };
              const { previewApi } = await import(
                /* @vite-ignore */ "/src/preview.ts"
              );
              const action = previewApi[name as keyof typeof previewApi] as (
                ...args: unknown[]
              ) => unknown;
              return action.apply(previewApi, args);
            };
          },
        },
      ),
    });
  }, method);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
}

async function allowRetry(page: Page) {
  await page.evaluate(() => {
    (
      window as unknown as { __persistence: { fail: boolean } }
    ).__persistence.fail = false;
  });
}

test("failed settings writes keep the effective setting and show no success notification", async ({
  page,
}) => {
  await failWrites(page, "updateSettings");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Application", exact: true }).click();
  await page.getByRole("button", { name: "dark", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Local data write failed",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByText("Changes saved", { exact: true })).toHaveCount(0);
  await allowRetry(page);
  await page.getByRole("button", { name: "dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
});

test("failed correction persistence retains the draft and original until retry succeeds", async ({
  page,
}) => {
  await failWrites(page, "updateTranscript");
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Correct transcript" });
  await draft.fill("Unsaved correction with 👋");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Local data write failed",
  );
  await expect(draft).toHaveValue("Unsaved correction with 👋");
  await expect(page.getByText("Correction saved", { exact: true })).toHaveCount(
    0,
  );
  await allowRetry(page);
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(draft).toHaveCount(0);
  await expect(
    page.getByText("Unsaved correction with 👋", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Correction saved", { exact: true }),
  ).toBeVisible();
});

test("failed rewrite application preserves source and preview without claiming success", async ({
  page,
}) => {
  await failWrites(page, "setTranscriptRewrite");
  const original = await page.evaluate(
    async () => (await window.delulu.getHistory())[0],
  );
  await page.getByRole("button", { name: "Rewrite", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rewrite transcript" });
  await dialog.getByRole("button", { name: "Generate preview" }).click();
  const preview = dialog.getByRole("textbox", { name: "Rewrite preview" });
  await expect(preview).not.toBeEmpty();
  const proposed = await preview.inputValue();
  await dialog.getByRole("button", { name: "Use this rewrite" }).click();
  await expect(dialog).toContainText("Could not apply this rewrite");
  await expect(preview).toHaveValue(proposed);
  expect(
    await page.evaluate(async () => (await window.delulu.getHistory())[0]),
  ).toEqual(original);
  await expect(page.getByText("Rewrite applied", { exact: true })).toHaveCount(
    0,
  );
  await allowRetry(page);
  await dialog.getByRole("button", { name: "Use this rewrite" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Rewrite applied", { exact: true }),
  ).toBeVisible();
  const accepted = await page.evaluate(
    async () => (await window.delulu.getHistory())[0],
  );
  expect(accepted.text).toBe(original.text);
  expect(accepted.magicText).toBe(proposed);
});

for (const method of ["deleteHistory", "clearHistory"]) {
  test(`failed ${method} leaves the rendered history intact without a success notification`, async ({
    page,
  }) => {
    await failWrites(page, method);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "History", exact: true })
      .click();
    const cards = page.locator(".transcript-card:visible");
    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThan(0);
    const openConfirmation = async () => {
      if (method === "deleteHistory")
        await page
          .getByRole("button", { name: "Delete transcript", exact: true })
          .first()
          .click();
      else
        await page
          .getByRole("button", { name: "Clear history", exact: true })
          .click();
      await page
        .getByRole("dialog")
        .getByRole("button", {
          name:
            method === "deleteHistory" ? "Delete transcript" : "Clear history",
          exact: true,
        })
        .click();
    };
    await openConfirmation();
    await expect(page.getByRole("alert")).toContainText(
      "Local data write failed",
    );
    await expect(cards).toHaveCount(initialCount);
    const success =
      method === "deleteHistory" ? "Transcript deleted" : "History cleared";
    await expect(page.getByText(success, { exact: true })).toHaveCount(0);
    await allowRetry(page);
    await openConfirmation();
    await expect(cards).toHaveCount(
      method === "deleteHistory" ? initialCount - 1 : 0,
    );
    await expect(page.getByText(success, { exact: true })).toBeVisible();
  });
}
