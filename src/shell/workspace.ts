import { bridge } from "../bridge";
import type { useWorkspace } from "../hooks/useWorkspace";
import { retryState } from "../components/RetryNotice";
import { isRestingMessage } from "../statusLabels";

export type Workspace = ReturnType<typeof useWorkspace>;

export function isRecording(w: Workspace) {
  return w.status.phase === "listening" || w.status.phase === "paused";
}

/** Capture, transcription or a model operation is under way. */
export function isBusy(w: Workspace) {
  return (
    isRecording(w) ||
    ["preparing", "loading", "transcribing"].includes(w.status.phase) ||
    ["preparing", "loading", "rewriting"].includes(w.magicStatus.phase)
  );
}

/**
 * The line under the pearl. Empty while speech simply rests ready, and for an
 * unrecoverable error, which the notice above already states.
 */
export function homeCaption(w: Workspace) {
  if (!w.ready)
    return w.startupError ? "Workspace unavailable" : "Opening your workspace…";
  if (["preparing", "loading", "rewriting"].includes(w.magicStatus.phase))
    return w.magicStatus.message;
  if (w.status.phase === "error" && !retryState(w.status).recoverable)
    return "";
  return isRestingMessage(w.status) ? "" : w.status.message;
}

/** Desktop commands shared by notices and pages; failures surface as the workspace error. */
export function workspaceCommands(w: Workspace) {
  const run = (operation: () => Promise<unknown>, message?: string) => () => {
    void w.action(operation, message);
  };
  return {
    run,
    download: run(() => bridge.downloadUpdate()),
    install: run(() => bridge.installUpdate()),
    setup: run(() => bridge.setupModel()),
    cancelSetup: run(() => bridge.cancelModelSetup()),
    load: run(() => bridge.loadModel()),
    unload: run(() => bridge.unloadModel()),
    setupMagic: run(() => bridge.setupMagic()),
    cancelSetupMagic: run(() => bridge.cancelMagicSetup()),
    loadMagic: run(() => bridge.loadMagic()),
    unloadMagic: run(() => bridge.unloadMagic()),
    retryRecording: run(() => bridge.retryRecording()),
    discardRecording: run(() => bridge.discardFailedRecording()),
  };
}
