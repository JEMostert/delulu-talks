import { expect, test, type Page } from "@playwright/test";
import type { DictationStatus, MagicStatus } from "../../src/types";

const unloaded = {
  phase: "idle",
  engine: "unloaded",
  message: "Unloaded",
} as const;

async function openModels(
  page: Page,
  speech: DictationStatus = unloaded,
  rewrite: MagicStatus = unloaded,
) {
  await page.addInitScript(
    ({ speech, rewrite }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      const calls: string[] = [];
      const emit = (event: string, value: unknown) =>
        listeners.get(event)?.forEach((callback) => callback(value));
      Object.assign(window, { __models: { calls, emit } });
      localStorage.setItem(
        "delulu-demo-settings",
        JSON.stringify({ onboardingComplete: true }),
      );
      Object.assign(window, {
        delulu: new Proxy(
          {},
          {
            get(_target, method: string) {
              if (method.startsWith("on"))
                return (callback: (value: unknown) => void) => {
                  const callbacks = listeners.get(method) ?? new Set();
                  listeners.set(method, callbacks);
                  callbacks.add(callback);
                  return () => callbacks.delete(callback);
                };
              return async (...args: unknown[]) => {
                calls.push(method);
                if (method === "getStatus") return speech;
                if (method === "getMagicStatus") return rewrite;
                if (
                  [
                    "setupModel",
                    "loadModel",
                    "unloadModel",
                    "setupMagic",
                    "loadMagic",
                    "unloadMagic",
                  ].includes(method)
                ) {
                  emit(
                    method.endsWith("Magic") ? "onMagicStatus" : "onStatus",
                    {
                      phase: "idle",
                      engine: method.startsWith("unload")
                        ? "unloaded"
                        : "ready",
                      message: "Fixture lifecycle completed",
                    },
                  );
                  return;
                }
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
    { speech, rewrite },
  );
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Models", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Rewrite where your text is" }),
  ).toBeVisible();
}

const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __models: { calls: string[] } }).__models.calls,
  );

test("speech and rewrite lifecycle controls reach their own operations alongside diagnostics", async ({
  page,
}) => {
  await openModels(page);
  await page.getByRole("button", { name: "Load model", exact: true }).click();
  await page
    .getByRole("button", { name: "Load rewriting", exact: true })
    .click();
  await page.getByRole("button", { name: "Unload", exact: true }).click();
  await page
    .getByRole("button", { name: "Unload rewriting", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Local rewrite model" })
    .selectOption("qwen35Large");
  await expect(
    page.getByRole("combobox", { name: "Local rewrite model" }),
  ).toHaveValue("qwen35Large");
  await expect(
    page.getByRole("heading", { name: "A quick health check" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const operations = await calls(page);
  for (const operation of [
    "loadModel",
    "loadMagic",
    "unloadModel",
    "unloadMagic",
    "updateSettings",
    "getDiagnostics",
  ])
    expect(operations).toContain(operation);
  expect(
    operations.filter((operation) => operation === "getDiagnostics").length,
  ).toBeGreaterThanOrEqual(2);
});

test("both setup sections show honest stage progress and disable conflicting operations", async ({
  page,
}) => {
  await openModels(
    page,
    {
      phase: "preparing",
      engine: "settingUp",
      message: "Installing speech",
      detail: "Speech import check",
      progress: 0.25,
    },
    {
      phase: "loading",
      engine: "loading",
      message: "Loading rewriting",
      detail: "Rewrite warmup",
      progress: null,
    },
  );
  await expect(
    page.getByRole("progressbar", { name: "Model setup stages", exact: true }),
  ).toHaveAttribute("value", "0.25");
  await expect(
    page.getByRole("progressbar", { name: "Rewrite model setup stages" }),
  ).not.toHaveAttribute("value");
  await expect(
    page.getByText("Speech import check", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Rewrite warmup", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Repair engine", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Repair rewriting", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Local rewrite model" }),
  ).toBeDisabled();
});

test("phase and engine errors both offer an explicit repair in the matching section", async ({
  page,
}) => {
  await openModels(
    page,
    { phase: "idle", engine: "error", message: "Speech backend unavailable" },
    { phase: "error", engine: "unloaded", message: "Rewrite operation failed" },
  );
  const speech = page
    .getByRole("alert")
    .filter({ hasText: "Speech backend unavailable" });
  const rewrite = page
    .getByRole("alert")
    .filter({ hasText: "Rewrite operation failed" });
  await expect(speech).toBeVisible();
  await expect(rewrite).toBeVisible();
  await speech.getByRole("button", { name: "Repair", exact: true }).click();
  await rewrite
    .getByRole("button", { name: "Repair rewriting", exact: true })
    .click();
  expect(await calls(page)).toContain("setupModel");
  expect(await calls(page)).toContain("setupMagic");
});

test("rewrite inference locks model operations without showing setup-stage progress", async ({
  page,
}) => {
  await openModels(
    page,
    { phase: "idle", engine: "ready", message: "Speech ready" },
    { phase: "rewriting", engine: "ready", message: "Rewriting a transcript" },
  );
  await expect(
    page.getByRole("button", { name: "Unload", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Unload rewriting", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Local rewrite model" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("progressbar", { name: "Rewrite model setup stages" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Rewriting a transcript", { exact: true }),
  ).toBeVisible();
});
