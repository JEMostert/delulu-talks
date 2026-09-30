import { expect, test, type Page } from "@playwright/test";
import type { CustomWord } from "../../src/types";

const signature = "Best regards,\nExample\nEngineering";
const speech = "Please sign off with the original speech.";

async function openVocabulary(page: Page, customWords: CustomWord[]) {
  await page.addInitScript(
    ({ customWords, speech }) => {
      const writes: string[] = [];
      const records = [
        {
          id: "collision-source",
          createdAt: 1_700_000_000_000,
          durationMs: 2000,
          text: speech,
          personalizedText: "Existing clean result remains unchanged.",
          magicText: "Existing reviewed output remains unchanged.",
          magicModel: "qwen35Medium",
          magicPreset: "polish",
          model: "r2t2",
          language: "en",
          source: "dictation",
          processingTimeMs: 10,
        },
      ];
      if (!localStorage.getItem("delulu-demo-settings"))
        localStorage.setItem(
          "delulu-demo-settings",
          JSON.stringify({
            onboardingComplete: true,
            customWords,
            language: "en",
            shortcut: "CTRL+ALT+F7",
          }),
        );
      Object.assign(window, { __collisions: { writes, records } });
      Object.assign(window, {
        delulu: new Proxy(
          {},
          {
            get(_target, method: string) {
              if (method.startsWith("on")) return () => () => {};
              return async (...args: unknown[]) => {
                if (method === "getHistoryBatchSnapshot")
                  return { deletion: null, records: structuredClone(records) };
                if (method === "getHistory") return structuredClone(records);
                if (
                  [
                    "updateSettings",
                    "updateTranscript",
                    "setTranscriptRewrite",
                    "deleteHistory",
                    "clearHistory",
                  ].includes(method)
                )
                  writes.push(method);
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
    },
    { customWords, speech },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Personalization", exact: true }).click();
}

const snapshot = (page: Page) =>
  page.evaluate(async () => {
    const { bridge } = await import(/* @vite-ignore */ "/src/bridge.ts");
    return {
      settings: localStorage.getItem("delulu-demo-settings"),
      history: await bridge.getHistory(),
      writes: (window as unknown as { __collisions: { writes: string[] } })
        .__collisions.writes,
    };
  });

const disabledShortcutMessage =
  "Correction trigger “SIGN OFF” is already used by text shortcut “my signature” (trigger “sign off”, disabled). Edit that rule or choose another phrase.";
const unicodeCorrectionMessage =
  "Text shortcut trigger “ς” is already used by correction “Sigma” (trigger “σ”). Edit that rule or choose another phrase.";

test("correction collisions identify a disabled shortcut alias without saving or changing reviewed speech", async ({
  page,
}) => {
  await openVocabulary(page, [
    {
      id: "signature",
      kind: "shortcut",
      term: "my signature",
      soundsLike: "regards, sign off",
      replacement: signature,
      enabled: false,
    },
  ]);
  const before = await snapshot(page);
  await page.getByRole("button", { name: "Add correction" }).click();
  let dialog = page.getByRole("dialog", { name: "New correction" });
  await dialog
    .getByRole("textbox", { name: "Recognized text" })
    .fill("unclaimed phrase, SIGN OFF");
  await dialog.getByRole("textbox", { name: "Replace with" }).fill("Sign-off");
  await dialog.getByRole("textbox", { name: "Test phrase" }).fill("SIGN OFF");
  await expect(dialog.getByRole("alert")).toHaveText(disabledShortcutMessage);
  await page.setViewportSize({ width: 760, height: 1000 });
  for (const element of [
    dialog,
    dialog.locator(".modal-body"),
    dialog.getByRole("alert"),
  ])
    expect(
      await element.evaluate(
        (node) => node.scrollWidth <= node.clientWidth + 1,
      ),
    ).toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Save rule" }),
  ).toBeDisabled();
  await expect(dialog.getByLabel("Rule preview")).toHaveText("Sign-off");
  await expect(
    dialog.getByRole("textbox", { name: "Recognized text" }),
  ).toHaveValue("unclaimed phrase, SIGN OFF");
  expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
  await expect(page.getByRole("button", { name: "Edit Sign-off" })).toHaveCount(
    0,
  );

  // Resolve deliberately, then test the same conflict while editing a saved rule.
  await page.getByRole("button", { name: "Add correction" }).click();
  dialog = page.getByRole("dialog", { name: "New correction" });
  await dialog
    .getByRole("textbox", { name: "Recognized text" })
    .fill("SIGN OFF");
  await dialog.getByRole("textbox", { name: "Replace with" }).fill("Sign-off");
  await expect(dialog.getByRole("alert")).toHaveText(disabledShortcutMessage);
  await dialog
    .getByRole("textbox", { name: "Recognized text" })
    .fill("sign of");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(
    dialog.getByRole("textbox", { name: "Replace with" }),
  ).toHaveValue("Sign-off");
  await expect(dialog.getByRole("button", { name: "Save rule" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await snapshot(page);
  expect(saved.writes).toEqual(["updateSettings"]);
  expect(saved.history).toEqual(before.history);
  const savedWords = JSON.parse(saved.settings!).customWords;
  expect(savedWords).toHaveLength(2);
  expect(savedWords).toContainEqual({
    id: "signature",
    kind: "shortcut",
    term: "my signature",
    soundsLike: "regards, sign off",
    replacement: signature,
    enabled: false,
  });
  expect(savedWords).toContainEqual(
    expect.objectContaining({
      kind: "correction",
      term: "Sign-off",
      soundsLike: "sign of",
      replacement: "",
      enabled: true,
    }),
  );
  await page
    .getByRole("button", { name: "Edit Sign-off", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Edit rule" });
  await expect(dialog.getByRole("button", { name: "Save rule" })).toBeEnabled();
  await dialog
    .getByRole("textbox", { name: "Recognized text" })
    .fill("sign of, SIGN OFF");
  await expect(dialog.getByRole("alert")).toHaveText(disabledShortcutMessage);
  await expect(
    dialog.getByRole("button", { name: "Save rule" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(await snapshot(page)).toEqual(saved);
  await page
    .getByRole("button", { name: "Edit Sign-off", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("textbox", { name: "Recognized text" }),
  ).toHaveValue("sign of");
  await page.keyboard.press("Escape");

  // Remember correction reaches the shared command guard, rather than the modal's
  // disabled Save rule control. The rejected callback must make no IPC write.
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "History", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review transcript", exact: true })
    .click();
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  await expect(page.locator(".transcript-original:visible")).toHaveText(speech);
  await page
    .getByRole("button", { name: "Remember correction", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Remember correction" });
  await dialog
    .getByRole("textbox", { name: "Recognized text" })
    .fill("SIGN OFF");
  await dialog.getByRole("textbox", { name: "Replace with" }).fill("Sign-off");
  await dialog.getByRole("button", { name: "Save correction rule" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(disabledShortcutMessage);
  await expect(
    dialog.getByRole("textbox", { name: "Recognized text" }),
  ).toHaveValue("SIGN OFF");
  await expect(
    dialog.getByRole("textbox", { name: "Replace with" }),
  ).toHaveValue("Sign-off");
  expect(await snapshot(page)).toEqual(saved);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".transcript-original:visible")).toHaveText(speech);
  expect(await snapshot(page)).toEqual(saved);
});

test("shortcut creation and editing show the precise Unicode correction alias and preserve multiline output", async ({
  page,
}) => {
  const initial: CustomWord[] = [
    {
      id: "sigma",
      kind: "correction",
      term: "Sigma",
      soundsLike: "spare, σ",
      replacement: "",
      enabled: true,
    },
    {
      id: "signature",
      kind: "shortcut",
      term: "my signature",
      soundsLike: "sign off",
      replacement: signature,
      enabled: true,
    },
  ];
  await openVocabulary(page, initial);
  await page.getByRole("tab", { name: "Text shortcuts", exact: true }).click();
  const before = await snapshot(page);
  await page.getByRole("button", { name: "Add shortcut" }).click();
  let dialog = page.getByRole("dialog", { name: "New text shortcut" });
  await dialog
    .getByRole("textbox", { name: "Trigger phrase" })
    .fill("new signature");
  await dialog
    .getByRole("textbox", { name: "Alternative triggers" })
    .fill("fresh phrase, ς");
  await dialog
    .getByRole("textbox", { name: "Expanded output" })
    .fill(signature);
  await expect(dialog.getByRole("alert")).toHaveText(unicodeCorrectionMessage);
  await expect(
    dialog.getByRole("button", { name: "Save rule" }),
  ).toBeDisabled();
  expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await snapshot(page)).toEqual(before);

  await page
    .getByRole("button", { name: "Edit my signature", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Edit rule" });
  // Existing aliases belong to this ID and must not collide with themselves.
  await expect(dialog.getByRole("button", { name: "Save rule" })).toBeEnabled();
  await dialog
    .getByRole("textbox", { name: "Alternative triggers" })
    .fill("sign off, ς");
  await dialog
    .getByRole("textbox", { name: "Expanded output" })
    .fill("Unsaved output\nMust not replace the signature");
  await expect(dialog.getByRole("alert")).toHaveText(unicodeCorrectionMessage);
  await expect(
    dialog.getByRole("button", { name: "Save rule" }),
  ).toBeDisabled();
  expect(await snapshot(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Edit my signature", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Edit rule" });
  await expect(
    dialog.getByRole("textbox", { name: "Expanded output" }),
  ).toHaveValue(signature);
  await expect(
    dialog.getByRole("textbox", { name: "Alternative triggers" }),
  ).toHaveValue("sign off");
  await expect(dialog.getByRole("button", { name: "Save rule" })).toBeEnabled();
  await dialog
    .getByRole("textbox", { name: "Alternative triggers" })
    .fill("sign off, ς");
  await expect(dialog.getByRole("alert")).toHaveText(unicodeCorrectionMessage);
  await dialog
    .getByRole("textbox", { name: "Alternative triggers" })
    .fill("sign off, final signoff");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Save rule" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await snapshot(page);
  expect(saved.writes).toEqual(["updateSettings"]);
  expect(saved.history).toEqual(before.history);
  const settings = JSON.parse(saved.settings!);
  expect(settings.customWords).toEqual([
    initial[0],
    { ...initial[1], aliases: [], soundsLike: "sign off, final signoff" },
  ]);
  expect(settings.language).toBe("en");
  expect(settings.shortcut).toBe("CTRL+ALT+F7");
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Personalization", exact: true }).click();
  await page.getByRole("tab", { name: "Text shortcuts", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit my signature", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("textbox", { name: "Expanded output" }),
  ).toHaveValue(signature);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("textbox", { name: "Alternative triggers" }),
  ).toHaveValue("sign off, final signoff");
  expect((await snapshot(page)).history).toEqual(before.history);
});

test("a long conflicting alias wraps inside a compact modal without writing or truncating its diagnostic", async ({
  page,
}) => {
  const alias = "a".repeat(900);
  await openVocabulary(page, [
    {
      id: "long-block",
      kind: "shortcut",
      term: "long shortcut",
      soundsLike: `earlier alias, ${alias}`,
      replacement: signature,
      enabled: true,
    },
  ]);
  await page.setViewportSize({ width: 760, height: 1000 });
  const before = await snapshot(page);
  await page.getByRole("button", { name: "Add correction" }).click();
  const dialog = page.getByRole("dialog", { name: "New correction" });
  await dialog
    .getByRole("textbox", { name: "Recognized text" })
    .fill(`free phrase, ${alias}`);
  await dialog
    .getByRole("textbox", { name: "Replace with" })
    .fill("Short result");
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(
    `Correction trigger “${alias}” is already used by text shortcut “long shortcut” (trigger “${alias}”). Edit that rule or choose another phrase.`,
  );
  for (const element of [dialog, dialog.locator(".modal-body"), alert])
    expect(
      await element.evaluate(
        (node) => node.scrollWidth <= node.clientWidth + 1,
      ),
    ).toBe(true);
  await expect(
    dialog.getByRole("button", { name: "Save rule" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("textbox", { name: "Recognized text" }),
  ).toHaveValue(`free phrase, ${alias}`);
  expect(await snapshot(page)).toEqual(before);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
});
