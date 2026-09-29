export type RecoveryState = {
  canReload: boolean;
  reason: string | null;
  canStopRecording: boolean;
};

export type RecoveryInput = {
  captureActive: boolean;
  canStopRecording: boolean;
  runtimeBusy: boolean;
  settingsBusy: boolean;
  updateBusy: boolean;
};

/** Read authoritative service state again when the reload is requested. */
export function rendererRecoveryState(input: RecoveryInput): RecoveryState {
  const reason = input.captureActive
    ? "Finish the current capture or transcription before reloading."
    : input.runtimeBusy
      ? "Wait for model setup or inference to finish before reloading."
      : input.settingsBusy
        ? "Wait for pending settings changes to save before reloading."
        : input.updateBusy
          ? "Wait for the current update operation to finish before reloading."
          : null;
  return {
    canReload: reason === null,
    reason,
    canStopRecording: input.captureActive && input.canStopRecording,
  };
}

/** Keep checking and reloading synchronous so another operation cannot slip in. */
export function reloadRenderer(
  input: RecoveryInput,
  onReload: () => void,
): void {
  const state = rendererRecoveryState(input);
  if (!state.canReload) throw new Error(state.reason!);
  onReload();
}
