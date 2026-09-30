import { identifySyntheticMicrophone } from "./syntheticMicrophone";
import { expect, test, type Page } from "@playwright/test";

// Real React and Chromium PCM capture, with desktop IPC/inference fixtures.
async function openScenario(page: Page, controllerFault = false) {
  await identifySyntheticMicrophone(page);
  await page.addInitScript((controllerFault) => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const state = {
      phase: "idle",
      runtimeBusy: false,
      settingsPending: false,
      diagnosticMode: "ok",
      copyFails: false,
      copies: [] as string[],
      submissions: [] as { bytes: number; sampleRate: number; riff: string }[],
      controllerFailures: 0,
      cancelCalls: 0,
      saves: 0,
      savedTheme: "",
      failAtReload: false,
      releaseSave: null as (() => void) | null,
    };
    function emit(name: string, value: unknown) {
      listeners.get(name)?.forEach((callback) => callback(value));
    }
    function speech() {
      return {
        phase: state.phase,
        engine: "ready",
        message: state.phase,
        model: "r2t2",
      };
    }
    Object.assign(window, {
      __recovery: state,
      __crashView: () => emit("onNavigate", "missing-page"),
      delulu: new Proxy(
        {},
        {
          get(_target, property: string) {
            if (property.startsWith("on"))
              return (callback: (value: unknown) => void) => {
                if (controllerFault && property === "onStatus")
                  throw new Error("Recording controller initialization failed");
                const callbacks = listeners.get(property) ?? new Set();
                callbacks.add(callback);
                listeners.set(property, callbacks);
                return () => callbacks.delete(callback);
              };
            return async (...args: unknown[]) => {
              const { previewApi } = await import(
                /* @vite-ignore */ "/src/preview.ts"
              );
              if (property === "getStatus") return speech();
              if (property === "getRendererRecoveryState") {
                const active = state.phase !== "idle";
                const reason = active
                  ? "Finish the current capture or transcription before reloading."
                  : state.runtimeBusy
                    ? "Wait for model setup or inference to finish before reloading."
                    : state.settingsPending
                      ? "Wait for pending settings changes to save before reloading."
                      : null;
                return {
                  canReload: !reason,
                  reason,
                  canStopRecording: state.phase === "listening",
                };
              }
              if (property === "reloadWorkspace") {
                if (state.runtimeBusy || state.failAtReload)
                  throw new Error(
                    "Model operation started before reload; wait for it to finish.",
                  );
                sessionStorage.setItem(
                  "recoveryReloads",
                  String(
                    Number(sessionStorage.getItem("recoveryReloads") ?? "0") +
                      1,
                  ),
                );
                return previewApi.reloadWorkspace();
              }
              if (property === "rendererControllerFailed") {
                state.controllerFailures++;
                return;
              }
              if (property === "getDiagnostics") {
                if (state.diagnosticMode === "reject")
                  throw new Error("Diagnostics temporarily unavailable");
                if (state.diagnosticMode === "hang")
                  return new Promise(() => {});
                return previewApi.getDiagnostics();
              }
              if (property === "copyText") {
                if (state.copyFails)
                  throw new Error("Clipboard is unavailable");
                state.copies.push(String(args[0]));
                return;
              }
              if (property === "updateSettings" && state.settingsPending) {
                state.saves++;
                await new Promise<void>((resolve) => {
                  state.releaseSave = resolve;
                });
                const next = await previewApi.updateSettings(args[0]);
                state.savedTheme = next.theme;
                state.settingsPending = false;
                emit("onSettingsChanged", next);
                return next;
              }
              if (property === "startDictation") {
                state.phase = "opening";
                emit("onRecorderCommand", {
                  action: "start",
                  inputDeviceId: "fixture-microphone",
                });
                return;
              }
              if (property === "recordingStarted") {
                state.phase = "listening";
                emit("onStatus", speech());
                return;
              }
              if (property === "stopDictation") {
                state.phase = "stopping";
                emit("onRecorderCommand", {
                  action: "stop",
                  inputDeviceId: "fixture-microphone",
                });
                return;
              }
              if (property === "submitRecording") {
                const submission = args[0] as { wav: Uint8Array };
                state.submissions.push({
                  bytes: submission.wav.length,
                  sampleRate: new DataView(submission.wav.buffer).getUint32(
                    24,
                    true,
                  ),
                  riff: new TextDecoder().decode(submission.wav.slice(0, 4)),
                });
                state.phase = "idle";
                emit("onStatus", speech());
                return;
              }
              const method = previewApi[
                property as keyof typeof previewApi
              ] as (...args: unknown[]) => unknown;
              return method.apply(previewApi, args);
            };
          },
        },
      ),
    });
    localStorage.setItem(
      "delulu-demo-settings",
      JSON.stringify({ onboardingComplete: true }),
    );
  }, controllerFault);
  await page.goto("/");
  if (!controllerFault)
    await expect(
      page.getByRole("heading", { name: "Controls", exact: true }),
    ).toBeVisible();
}

async function crash(page: Page) {
  await page.evaluate(() => (window as any).__crashView());
  await expect(
    page.getByRole("heading", { name: "The workspace could not be displayed" }),
  ).toBeVisible();
}

test("render failures retain editable text, isolate diagnostics, and reload deliberately", async ({
  page,
}) => {
  await openScenario(page);
  await page.getByRole("button", { name: "Speech", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Correct transcript", exact: true })
    .fill("Recent Dutch edit: morgen om 14:30 — café.");
  await crash(page);
  await expect(
    page.getByRole("heading", { name: "The workspace could not be displayed" }),
  ).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Recovered Correct transcript 1" }),
  ).toHaveValue("Recent Dutch edit: morgen om 14:30 — café.");
  await page.getByRole("button", { name: "Copy text edit 1" }).click();
  await page.getByRole("button", { name: "Check diagnostics" }).click();
  await expect(page.getByLabel("Recovery diagnostics")).toContainText(
    "Browser preview",
  );
  await expect(page.getByLabel("Recovery diagnostics")).not.toContainText(
    "Recent Dutch edit",
  );
  await page
    .getByRole("button", { name: "Copy diagnostics", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__recovery.copies[0])).toBe(
    "Recent Dutch edit: morgen om 14:30 — café.",
  );
  expect(
    await page.evaluate(() => (window as any).__recovery.controllerFailures),
  ).toBe(0);
  await page.setViewportSize({ width: 860, height: 650 });
  expect(
    await page
      .locator("main")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Reload workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Controls", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("recoveryReloads")),
  ).toBe("1");
});

test("a UI crash leaves real microphone capture alive until Stop and save", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["microphone"]);
  await openScenario(page);
  await page.evaluate(async () => {
    const { PcmRecorder } = await import(/* @vite-ignore */ "/src/recorder.ts");
    const cancel = PcmRecorder.prototype.cancel;
    PcmRecorder.prototype.cancel = function () {
      (window as any).__recovery.cancelCalls++;
      return cancel.call(this);
    };
    await window.delulu!.startDictation();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__recovery.phase))
    .toBe("listening");
  await page.waitForTimeout(350);
  await crash(page);
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() => (window as any).__recovery.cancelCalls),
  ).toBe(0);
  await page.getByRole("button", { name: "Stop and save recording" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__recovery.submissions.length),
    )
    .toBe(1);
  const submission = await page.evaluate(
    () => (window as any).__recovery.submissions[0],
  );
  expect(submission.bytes).toBeGreaterThan(44);
  expect(submission).toMatchObject({ riff: "RIFF", sampleRate: 16000 });
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => (window as any).__recovery.cancelCalls),
  ).toBe(0);
});

test("pending settings saves finish once after a render failure", async ({
  page,
}) => {
  await openScenario(page);
  await page.evaluate(() => {
    (window as any).__recovery.settingsPending = true;
  });
  await page.getByRole("button", { name: "Switch color theme" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).__recovery.releaseSave)),
    )
    .toBe(true);
  await crash(page);
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).__recovery.releaseSave());
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__recovery.saves)).toBe(1);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("delulu-demo-settings")!).theme,
    ),
  ).toBe("dark");
});

test("diagnostic rejection, stalls and clipboard failures remain recoverable", async ({
  page,
}) => {
  await openScenario(page);
  await crash(page);
  await page.evaluate(() => {
    (window as any).__recovery.diagnosticMode = "reject";
  });
  await page.getByRole("button", { name: "Check diagnostics" }).click();
  await expect(page.getByRole("alert").last()).toHaveText(
    "Diagnostics temporarily unavailable",
  );
  await page.evaluate(() => {
    (window as any).__recovery.diagnosticMode = "hang";
  });
  await page.getByRole("button", { name: "Check diagnostics" }).click();
  await expect(page.getByRole("alert").last()).toContainText(
    "within 5 seconds",
    { timeout: 7000 },
  );
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__recovery.diagnosticMode = "ok";
    (window as any).__recovery.copyFails = true;
  });
  await page.getByRole("button", { name: "Check diagnostics" }).click();
  await expect(page.getByLabel("Recovery diagnostics")).toContainText(
    "Browser preview",
  );
  await page
    .getByRole("button", { name: "Copy diagnostics", exact: true })
    .click();
  await expect(
    page.getByText("Clipboard is unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Diagnostics copied", { exact: true }),
  ).toHaveCount(0);
});

test("reload rechecks authoritative state after an idle preview", async ({
  page,
}) => {
  await openScenario(page);
  await crash(page);
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__recovery.failAtReload = true;
  });
  await page.getByRole("button", { name: "Reload workspace" }).click();
  await expect(
    page.getByText(
      "Model operation started before reload; wait for it to finish.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("recoveryReloads")),
  ).toBeNull();
  await page.evaluate(() => {
    (window as any).__recovery.runtimeBusy = true;
  });
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toBeDisabled();
});

test("a controller initialization crash still exposes diagnostics and honest capture limits", async ({
  page,
}) => {
  await openScenario(page, true);
  await expect(
    page.getByRole("heading", { name: "The workspace could not be displayed" }),
  ).toBeVisible();
  await expect(
    page.getByText("Recording controller initialization failed", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /An unfinished microphone capture may have been interrupted/,
    ),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__recovery.controllerFailures),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Check diagnostics" }).click();
  await expect(page.getByLabel("Recovery diagnostics")).toContainText(
    "Browser preview",
  );
});
