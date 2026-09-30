import { expect, test, type Page } from "@playwright/test";

async function historyFixture(page: Page, empty = false) {
  await page.addInitScript((empty) => {
    localStorage.setItem(
      "delulu-demo-settings",
      JSON.stringify({ onboardingComplete: true }),
    );
    const base = {
      durationMs: 1000,
      processingTimeMs: 10,
      text: "Immutable recognition",
      model: "r2t2",
      language: "en",
      source: "dictation",
    };
    const records = empty
      ? []
      : [
          {
            ...base,
            id: "target",
            createdAt: new Date(2026, 8, 30, 23, 59, 59, 999).getTime(),
            source: "file",
            sourceName: "Dutch meeting.wav",
            model: "r2t2Mlx",
            language: "nl",
            magicText: "Rewritten shared needle",
            personalizedText: "Personalized needle",
          },
          {
            ...base,
            id: "recording",
            createdAt: new Date(2026, 8, 30).getTime(),
            text: "Recorded shared needle",
          },
          {
            ...base,
            id: "legacy",
            createdAt: new Date(2026, 8, 29, 12).getTime(),
            model: "qwen3Asr",
            language: "xx",
            source: "file",
            sourceName: "Historical file.wav",
            text: "Historical shared needle",
          },
          {
            ...base,
            id: "tomorrow",
            createdAt: new Date(2026, 9, 1).getTime(),
            source: "file",
            model: "r2t2Mlx",
            language: "nl",
            magicText: "Tomorrow shared needle",
          },
        ];
    Object.assign(window, { __historyFixture: { records, writes: [] } });
    Object.assign(window, {
      delulu: new Proxy(
        {},
        {
          get(_target, property: string) {
            if (property.startsWith("on")) return () => () => undefined;
            return async (...args: unknown[]) => {
              if (property === "getHistoryBatchSnapshot")
                return { deletion: null, records };
              if (property === "getHistory") return records;
              if (
                [
                  "updateTranscript",
                  "setTranscriptRewrite",
                  "deleteHistory",
                  "clearHistory",
                  "updateSettings",
                ].includes(property)
              ) {
                const fixture = (
                  window as unknown as {
                    __historyFixture: { writes: string[] };
                  }
                ).__historyFixture;
                fixture.writes.push(property);
              }
              const { previewApi } = await import(
                /* @vite-ignore */ "/src/preview.ts"
              );
              const method = previewApi[
                property as keyof typeof previewApi
              ] as (...args: unknown[]) => unknown;
              return method.apply(previewApi, args);
            };
          },
        },
      ),
    });
  }, empty);
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "History", exact: true })
    .click();
}

const cards = (page: Page) => page.locator(".transcript-card:visible");

test("all five filters combine with search; reset restores untouched history", async ({
  page,
}) => {
  await historyFixture(page);
  const before = await page.evaluate(() =>
    JSON.stringify(
      (window as unknown as { __historyFixture: unknown }).__historyFixture,
    ),
  );
  await expect(cards(page)).toHaveCount(4);
  await page.getByLabel("Start date", { exact: true }).fill("2026-09-30");
  await page.getByLabel("End date", { exact: true }).fill("2026-09-30");
  await expect(cards(page)).toHaveCount(2);
  await page
    .getByLabel("Speech model", { exact: true })
    .selectOption("r2t2Mlx");
  await page
    .getByLabel("Transcript language", { exact: true })
    .selectOption("nl");
  await page
    .getByLabel("Recording/import source", { exact: true })
    .selectOption("file");
  await page.getByLabel("Rewrite status", { exact: true }).selectOption("yes");
  await page
    .getByRole("textbox", { name: "Search transcript history" })
    .fill("personalized");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("Dutch meeting.wav");
  await expect(
    page.getByRole("status").filter({ hasText: "1 of 4 transcripts" }),
  ).toHaveText("1 of 4 transcripts");
  await page
    .getByRole("button", { name: "Review transcript", exact: true })
    .click();
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  await expect(page.locator(".transcript-original:visible")).toHaveText(
    "Immutable recognition",
  );
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(page.getByLabel("Speech model", { exact: true })).toHaveValue(
    "r2t2Mlx",
  );
  await page.getByRole("button", { name: "Reset search and filters" }).click();
  await expect(cards(page)).toHaveCount(4);
  await expect(
    page.getByRole("textbox", { name: "Search transcript history" }),
  ).toBeEmpty();
  await expect(
    page.getByRole("button", { name: "Reset search and filters" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { __historyFixture: unknown }).__historyFixture,
      ),
    ),
  ).toBe(before);
});

test("historical model, unknown language, recordings and unrewritten results remain reachable", async ({
  page,
}) => {
  await historyFixture(page);
  await page
    .getByLabel("Speech model", { exact: true })
    .selectOption("qwen3Asr");
  await page
    .getByLabel("Transcript language", { exact: true })
    .selectOption("xx");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("Historical file.wav");
  await page.getByLabel("Rewrite status", { exact: true }).selectOption("yes");
  await expect(
    page.getByText("No matching transcripts", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset search and filters" }).click();
  await page
    .getByLabel("Recording/import source", { exact: true })
    .selectOption("dictation");
  await page.getByLabel("Rewrite status", { exact: true }).selectOption("no");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("Recorded shared needle");
});

test("reversed dates explain the error and can be corrected or reset", async ({
  page,
}) => {
  await historyFixture(page);
  await page.getByLabel("Start date", { exact: true }).fill("2026-10-01");
  await page.getByLabel("End date", { exact: true }).fill("2026-09-30");
  await expect(page.getByRole("alert")).toHaveText(
    "Start date must be on or before end date.",
  );
  await expect(page.getByLabel("Start date", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(cards(page)).toHaveCount(0);
  await page.getByLabel("Start date", { exact: true }).fill("2026-09-30");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Reset search and filters" }).click();
  await expect(cards(page)).toHaveCount(4);
});

test("empty history and compact keyboard controls remain usable", async ({
  page,
}) => {
  await historyFixture(page, true);
  await page.setViewportSize({ width: 860, height: 800 });
  await expect(
    page.getByText("No transcripts yet", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear history", exact: true }),
  ).toBeDisabled();
  const source = page.getByLabel("Recording/import source", { exact: true });
  await source.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(source).toHaveValue("dictation");
  await page.getByRole("button", { name: "Reset search and filters" }).click();
  expect(
    await page
      .locator(".page-scroll")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await expect(source).toHaveValue("all");
});
