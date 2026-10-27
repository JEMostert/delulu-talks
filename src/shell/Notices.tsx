import { RotateCcw } from "lucide-react";
import { HistoryDeletionNotice } from "../components/HistoryDeletionNotice";
import { OperationResumeNotice } from "../components/OperationResumeNotice";
import { PasteLastNotice } from "../components/PasteLastNotice";
import { PasteRecoveryNotice } from "../components/PasteRecoveryNotice";
import { RetryNotice } from "../components/RetryNotice";
import { ServiceRecovery } from "../components/ServiceRecovery";
import { UpdateNotice } from "../components/UpdateNotice";
import { Alert } from "../components/ui";
import type { Page } from "../types";
import { workspaceCommands, type Workspace } from "./workspace";

/** Alerts float over the ocean on Home and sit under the header in a sheet. */
export function Notices({
  workspace: w,
  busy,
  panelOpen,
  onNavigate,
}: {
  workspace: Workspace;
  busy: boolean;
  panelOpen: boolean;
  onNavigate: (page: Page) => void;
}) {
  const commands = workspaceCommands(w);
  return (
    <div className={`workspace-notices ${panelOpen ? "in-panel" : ""}`}>
      {panelOpen && (
        <UpdateNotice
          status={w.updateStatus}
          busy={busy}
          onDownload={commands.download}
          onInstall={commands.install}
        />
      )}
      <HistoryDeletionNotice
        state={w.historyDeletion}
        onUndo={w.undoDeletion}
        onHistory={() => onNavigate("history")}
      />
      {w.ready && <ServiceRecovery recovery={w.serviceRecovery} />}
      {panelOpen && (
        <OperationResumeNotice
          operations={w.operations}
          onImport={() => onNavigate("lab")}
        />
      )}
      {w.status.captureInputNotice && (
        <Alert tone="info">{w.status.captureInputNotice}</Alert>
      )}
      <PasteRecoveryNotice
        onCopied={() => w.setToast("Copied — paste it yourself")}
      />
      {w.error && <Alert onDismiss={() => w.setError(null)}>{w.error}</Alert>}
      <RetryNotice
        status={w.status}
        busy={busy}
        onEngines={w.page === "models" ? undefined : () => onNavigate("models")}
        onRetry={commands.retryRecording}
        onDiscard={commands.discardRecording}
      />
      <PasteLastNotice
        status={w.pasteLastStatus}
        onCancel={w.cancelPasteLast}
      />
      {w.startupError && (
        <Alert
          action={
            <button className="secondary-button" onClick={w.retryStartup}>
              <RotateCcw /> Retry
            </button>
          }
        >
          {w.startupError}
        </Alert>
      )}
    </div>
  );
}
