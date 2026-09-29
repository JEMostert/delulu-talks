import { expect, test } from "@playwright/test";
import fixtures from "../fixtures/golden-transcripts.json" with { type: "json" };

for (const fixture of fixtures) {
  test(`golden ${fixture.id}: correction, rewrite apply, undo and restore preserve source`, async ({
    page,
  }) => {
    await page.addInitScript((fixture) => {
      let record = {
        id: fixture.id,
        createdAt: 1,
        durationMs: 1000,
        text: fixture.source,
        personalizedText: fixture.personalized,
        model: "r2t2",
        language: fixture.language,
        source: "dictation",
        sourceName: fixture.id,
        processingTimeMs: 20,
        editedText: null as string | null,
        magicText: null as string | null,
      };
      const calls: { method: string; args: unknown[] }[] = [];
      Object.assign(window, {
        __golden: { calls, getRecord: () => structuredClone(record) },
      });
      Object.assign(window, {
        delulu: new Proxy(
          {},
          {
            get(_target, method: string) {
              if (method.startsWith("on")) return () => () => {};
              return async (...args: unknown[]) => {
                calls.push({ method, args });
                if (method === "getHistory") return [structuredClone(record)];
                if (method === "updateTranscript") {
                  if (
                    args[0] !== record.id ||
                    (args[1] !== fixture.corrected && args[1] !== null)
                  )
                    throw new Error("Unexpected correction payload");
                  record = {
                    ...record,
                    editedText: args[1] as string | null,
                    magicText: null,
                  };
                  return structuredClone(record);
                }
                if (method === "rewriteMagic") {
                  const request = args[0] as { text: string };
                  if (request.text !== fixture.corrected)
                    throw new Error("Rewrite must use the corrected source");
                  return {
                    text: fixture.rewritten,
                    model: "qwen35Medium",
                    preset: "concise",
                    processingTimeMs: 20,
                    inputCharacters: request.text.length,
                    outputCharacters: fixture.rewritten.length,
                    includedInferences: false,
                  };
                }
                if (method === "setTranscriptRewrite") {
                  const expected =
                    record.magicText ??
                    record.editedText ??
                    fixture.personalized;
                  if (args[0] !== record.id || args[2] !== expected)
                    throw new Error("Unexpected optimistic rewrite baseline");
                  record = {
                    ...record,
                    magicText:
                      (args[1] as { text: string } | null)?.text ?? null,
                  };
                  return structuredClone(record);
                }
                if (method === "copyText") return;
                const { previewApi } = await import(
                  /* @vite-ignore */ "/src/preview.ts"
                );
                const action = previewApi[
                  method as keyof typeof previewApi
                ] as (...args: unknown[]) => unknown;
                return action.apply(previewApi, args);
              };
            },
          },
        ),
      });
      localStorage.setItem(
        "delulu-demo-settings",
        JSON.stringify({ onboardingComplete: true, magicEnabled: false }),
      );
    }, fixture);
    await page.goto("/");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "History", exact: true })
      .click();
    const card = page.locator(".transcript-card:not(.inspector-card)");
    await card
      .getByRole("button", { name: "Review transcript", exact: true })
      .click();
    const text = card.locator(".transcript-original");
    // textContent preserves newlines and indentation; normalized text locators
    // would conceal corruption of exact shortcut blocks.
    expect(await text.textContent()).toBe(fixture.personalized);
    await card.getByRole("button", { name: "Speech", exact: true }).click();
    expect(await text.textContent()).toBe(fixture.source);
    await card.getByRole("button", { name: "Edit", exact: true }).click();
    await card
      .getByRole("textbox", { name: "Correct transcript" })
      .fill(fixture.corrected);
    await card
      .getByRole("button", { name: "Save correction", exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: "Restore", exact: true }),
    ).toBeVisible();
    expect(await text.textContent()).toBe(fixture.corrected);
    await card.getByRole("button", { name: "Rewrite", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Rewrite source" }),
    ).toHaveValue(fixture.corrected);
    await page
      .getByRole("button", { name: "Generate preview", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Rewrite preview" }),
    ).toHaveValue(fixture.rewritten);
    // Preview must not mutate current delivery before explicit Apply.
    expect(await text.textContent()).toBe(fixture.corrected);
    await page
      .getByRole("button", { name: "Use this rewrite", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Rewrite transcript" }),
    ).not.toBeVisible();
    await card.getByRole("button", { name: "Result", exact: true }).click();
    expect(await text.textContent()).toBe(fixture.rewritten);
    await card
      .getByRole("button", { name: "Undo rewrite", exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: "Undo rewrite", exact: true }),
    ).not.toBeVisible();
    expect(await text.textContent()).toBe(fixture.corrected);
    await card.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Restore", exact: true }),
    ).not.toBeVisible();
    expect(await text.textContent()).toBe(fixture.personalized);
    await card.getByRole("button", { name: "Speech", exact: true }).click();
    expect(await text.textContent()).toBe(fixture.source);
    const state = await page.evaluate(() => {
      const golden = (
        window as unknown as {
          __golden: {
            calls: { method: string; args: unknown[] }[];
            getRecord: () => {
              text: string;
              editedText: string | null;
              magicText: string | null;
            };
          };
        }
      ).__golden;
      return { calls: golden.calls, record: golden.getRecord() };
    });
    expect(state.record).toMatchObject({
      text: fixture.source,
      editedText: null,
      magicText: null,
    });
    const rewriteCalls = state.calls.filter(
      (call) => call.method === "setTranscriptRewrite",
    );
    expect(rewriteCalls).toHaveLength(2);
    expect(rewriteCalls[0].args[2]).toBe(fixture.corrected);
    expect(rewriteCalls[1].args[2]).toBe(fixture.rewritten);
  });
}
