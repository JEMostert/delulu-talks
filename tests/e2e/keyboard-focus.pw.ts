import { expect, test, type Locator, type Page } from "@playwright/test";

async function openWorkspace(page: Page, onboardingComplete = true) {
  await page.addInitScript(({ onboardingComplete }) => {
    localStorage.setItem("delulu-demo-settings", JSON.stringify({
      onboardingComplete,
      personalProfiles: { schemaVersion: 1, profiles: [{
        schemaVersion: 1, id: "keyboard-profile", name: "Keyboard English", language: "en",
        decode: { mode: "backend-default" },
        delivery: { autoPaste: false, copyToClipboard: true, keepHistory: true },
        vocabulary: { rules: [] }, technicalGrammar: { preserveIdentifiers: true, literalTerms: [] },
        context: { mode: "none" },
        rewrite: { enabled: false, model: "qwen35Small", preset: "polish", allowInferences: false },
      }] },
    }));
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const fixture = { calls: [] as string[], hold: false, resume: undefined as (() => void) | undefined };
    Object.assign(window, { __keyboard: fixture, delulu: new Proxy({}, {
      get(_target, method: string) {
        if (method.startsWith("on")) return (callback: (value: unknown) => void) => {
          const callbacks = listeners.get(method) ?? new Set();
          listeners.set(method, callbacks); callbacks.add(callback);
          return () => callbacks.delete(callback);
        };
        return async (...args: unknown[]) => {
          fixture.calls.push(method);
          if (method === "activatePersonalProfile" && fixture.hold) await new Promise<void>((resolve) => { fixture.resume = resolve; });
          const { previewApi } = await import(/* @vite-ignore */ "/src/preview.ts");
          const action = previewApi[method as keyof typeof previewApi] as (...values: unknown[]) => unknown;
          const result = await action.apply(previewApi, args);
          if (method === "updateSettings") listeners.get("onSettingsChanged")?.forEach((callback) => callback(result));
          return result;
        };
      },
    }) });
  }, { onboardingComplete });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeEnabled();
}

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 80; index++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("keyboard-only first-run setup reaches Models without starting installation", async ({ page }) => {
  await openWorkspace(page, false);
  const setup = page.getByRole("region", { name: "First-run setup" }).getByRole("button", { name: "Set up engine" });
  await expect(setup).toBeVisible();
  await tabTo(page, setup);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __keyboard: { calls: string[] } }).__keyboard.calls);
  expect(calls).not.toContain("setupModel");
});

test("palette traps Tab and restores visible keyboard focus to its opener", async ({ page }) => {
  await openWorkspace(page);
  const opener = page.getByRole("button", { name: "Open command palette" });
  await tabTo(page, opener);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Find a command" })).toBeFocused();
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("dialog") === document.querySelector("dialog[open]"))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await opener.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
});

test("a hidden opener returns focus to the named current page region", async ({ page }) => {
  await openWorkspace(page);
  const opener = page.getByRole("button", { name: "Open command palette" });
  await tabTo(page, opener);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
  // Simulate an opener hidden by a view transition while the dialog remains open.
  await opener.evaluate((element) => { element.hidden = true; });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Controls", exact: true })).toBeFocused();
});

test("keyboard palette history command focuses search after its dialog closes", async ({ page }) => {
  await openWorkspace(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByRole("combobox", { name: "Find a command" }).fill("search transcript history");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search transcript history" })).toBeFocused();
});

test("busy profile confirmation keeps Escape scoped and avoids duplicate activation", async ({ page }) => {
  await openWorkspace(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByRole("combobox", { name: "Find a command" }).fill("use profile keyboard english");
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("button", { name: "Switch profile", exact: true });
  await expect(confirm).toBeFocused();
  await page.evaluate(() => { (window as unknown as { __keyboard: { hold: boolean } }).__keyboard.hold = true; });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Switching…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Use profile: Keyboard English" })).toBeVisible();
  const calls = await page.evaluate(() => (window as unknown as { __keyboard: { calls: string[] } }).__keyboard.calls);
  expect(calls.filter((method) => method === "activatePersonalProfile")).toHaveLength(1);
  await page.evaluate(() => { (window as unknown as { __keyboard: { resume?: () => void } }).__keyboard.resume?.(); });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
