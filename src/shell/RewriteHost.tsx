import { bridge } from "../bridge";
import { RewriteDialog } from "../components/RewriteDialog";
import { createTranscriptCommands } from "../transcriptCommands";
import {
  deliveredText,
  transcriptSourceRevision,
  transcriptText,
} from "../transcriptText";
import type { Workspace } from "./workspace";

/** The rewrite preview survives page changes; it hides instead of closing. */
export function RewriteHost({
  workspace: w,
  onSetup,
}: {
  workspace: Workspace;
  onSetup: () => void;
}) {
  const rewrite = w.operations.rewriteOperation;
  if (!rewrite) return null;
  const record = w.history.find((item) => item.id === rewrite.transcriptId);
  const { actions } = createTranscriptCommands(w);
  return (
    <RewriteDialog
      key={rewrite.key}
      contextLabel={rewrite.label}
      text={record ? transcriptText(record) : rewrite.source}
      baseline={record ? deliveredText(record) : rewrite.baseline}
      sourceRevision={
        record ? transcriptSourceRevision(record) : rewrite.sourceRevision
      }
      sourceLanguage={rewrite.sourceLanguage}
      status={w.magicStatus}
      visible={rewrite.visible}
      onBackground={w.operations.hideRewrite}
      onOperationState={(phase) =>
        w.operations.rewriteState(rewrite.key, phase)
      }
      onClose={() => w.operations.closeRewrite(rewrite.key)}
      onSetup={onSetup}
      onCancelRewrite={bridge.cancelRewrite}
      onRewrite={(request) => w.operations.runRewrite(rewrite.key, request)}
      onApply={(result, source, sourceRevision) =>
        w.operations.applyRewrite(rewrite.key, () =>
          actions.onSetRewrite!(
            rewrite.transcriptId,
            result,
            source,
            sourceRevision,
          ),
        )
      }
    />
  );
}
