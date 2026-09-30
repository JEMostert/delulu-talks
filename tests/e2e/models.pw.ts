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
    .getByRole("button", { name: "Load rewrite model", exact: true })
    .click();
  await page.getByRole("button", { name: "Unload model", exact: true }).click();
  await page
    .getByRole("button", { name: "Unload rewrite model", exact: true })
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
  ).not.toHaveAttribute("value");
  await expect(
    page.getByRole("progressbar", { name: "Rewrite model setup stages" }),
  ).not.toHaveAttribute("value");
  await expect(
    page.getByText("Speech import check", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Rewrite warmup", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Repair runtime", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Repair rewrite runtime", exact: true }),
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
    page.getByRole("button", { name: "Unload model", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Unload rewrite model", exact: true }),
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

test("speech provenance distinguishes Windows pins from Linux defaults and links the weight license", async ({
  page,
}) => {
  await openModels(page);
  const details = page.locator("details").filter({
    has: page.getByText("R2T2: source, revision & license", { exact: true }),
  });
  await details.locator("summary").click();
  await expect(details.getByText("Linux CUDA", { exact: true })).toBeVisible();
  await expect(
    details.getByText("Download revision: Upstream default (not pinned)", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    details.getByRole("link", {
      name: "185ce639118ad1362d049ca0d8ed04b6ec5cd6c9 ↗",
      exact: true,
    }),
  ).toHaveAttribute(
    "href",
    "https://huggingface.co/netease-youdao/Confucius4-R2T2/tree/185ce639118ad1362d049ca0d8ed04b6ec5cd6c9",
  );
  const license = details.getByRole("link", {
    name: "NetEase Youdao Model Use License Agreement ↗",
    exact: true,
  });
  await expect(license).toHaveAttribute(
    "href",
    "https://github.com/netease-youdao/Confucius4-R2T2/blob/master/MODEL_LICENSE",
  );
  await expect(license).toHaveAttribute("target", "_blank");
  await expect(license).toHaveAttribute("rel", "noreferrer");
});

test("MLX provenance names the published BF16 conversion without claiming native validation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 1000 });
  await openModels(page, { ...unloaded, speechModel: "r2t2Mlx" });
  const details = page.locator("details").filter({
    has: page.getByText("R2T2: source, revision & license", { exact: true }),
  });
  await details.locator("summary").click();
  await expect(
    details.getByRole("link", {
      name: "747f5fc5f84bc9976baa2f02714e2fed67ed8611 ↗",
      exact: true,
    }),
  ).toHaveAttribute(
    "href",
    "https://huggingface.co/mlx-community/Confucius4-R2T2-bf16/tree/747f5fc5f84bc9976baa2f02714e2fed67ed8611",
  );
  await expect(details.getByText(/Unquantized BF16 conversion/)).toContainText(
    "1792021",
  );
  await expect(
    details.getByRole("link", { name: "Conversion source ↗", exact: true }),
  ).toHaveAttribute(
    "href",
    /747f5fc5f84bc9976baa2f02714e2fed67ed8611\/README.md$/,
  );
  await expect(
    page.getByText(/Mac hardware validation is pending/),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("optional rewrite provenance follows the selected model and remains honestly unpinned", async ({
  page,
}) => {
  await openModels(page);
  const section = page.getByRole("region", {
    name: "Rewrite where your text is",
  });
  await section.locator("details summary").click();
  for (const [id, size] of [
    ["qwen35Small", "0.8B"],
    ["qwen35Medium", "2B"],
    ["qwen35Large", "4B"],
  ]) {
    await page
      .getByRole("combobox", { name: "Local rewrite model" })
      .selectOption(id);
    await expect(
      section.getByRole("link", {
        name: `Qwen/Qwen3.5-${size} ↗`,
        exact: true,
      }),
    ).toHaveAttribute("href", `https://huggingface.co/Qwen/Qwen3.5-${size}`);
    await expect(
      section.getByRole("link", { name: "Apache 2.0 ↗", exact: true }),
    ).toHaveAttribute(
      "href",
      `https://huggingface.co/Qwen/Qwen3.5-${size}/blob/main/LICENSE`,
    );
    await expect(
      section.getByText("Download revision: Upstream default (not pinned)", {
        exact: true,
      }),
    ).toBeVisible();
  }
});
