import {
  rendererRecoveryState,
  reloadRenderer,
} from "../services/rendererRecovery";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerRendererIpc(
  { handle }: IpcRegistrar,
  {
    dictation,
    asr,
    settingsBusy,
    updates,
  }: Pick<
    IpcDependencies,
    | "dictation"
    | "asr"
    | "settingsBusy"
    | "updates"
  >,
): void {
  const recoveryInput = () => ({
    captureActive: dictation.isActive,
    canStopRecording: dictation.canStopRecording,
    runtimeBusy: asr.isBusy,
    settingsBusy: settingsBusy(),
    updateBusy: ["checking", "downloading"].includes(updates.getStatus().phase),
  });
  handle("renderer:recoveryState", () => rendererRecoveryState(recoveryInput()));
  handle("renderer:reload", (event) => {
    reloadRenderer(recoveryInput(), () => {
      // Close the shortcut start race until the new controller calls ready.
      dictation.recorderUnavailable();
      event.sender.reload();
    });
  });
  handle("renderer:controllerFailed", () => dictation.recorderUnavailable());
}
