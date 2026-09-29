import { rendererRecoveryState, reloadRenderer } from "../services/rendererRecovery";
import { rendererRecoveryState, reloadRenderer } from "../services/rendererRecovery";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerRendererIpc({ handle }: IpcRegistrar, { asr, paste, dictation, shortcut, updates, settingsBusy }: Pick<IpcDependencies, "asr" | "paste" | "dictation" | "shortcut" | "updates" | "settingsBusy">): void {
const recoveryInput = () => ({ captureActive: dictation.isActive, canStopRecording: dictation.canStopRecording, runtimeBusy: asr.isBusy, settingsBusy: settingsBusy(), updateBusy: ["checking", "downloading"].includes(updates.getStatus().phase) });
handle("renderer:recoveryState", () =>
    rendererRecoveryState(recoveryInput()),
  );
handle("renderer:reload", (event) => {
    reloadRenderer(recoveryInput(), () => {
      pasteLast.cancelPending(
      "Scheduled paste cancelled because the workspace reloaded.",
    );
      // Close the shortcut start race until the new controller calls ready.
      dictation.recorderUnavailable();
      event.sender.reload();
    });
  });
handle("renderer:controllerFailed", () => {
    pasteLast.cancelPending(
      "Scheduled paste cancelled because the workspace controller failed.",
    );
    dictation.recorderUnavailable();
  });
}
