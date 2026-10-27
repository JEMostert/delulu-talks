import { Alert } from "./ui";
import type { useWorkspaceOperations } from "../hooks/useWorkspaceOperations";

export function OperationResumeNotice({
  operations,
  onImport,
}: {
  operations: ReturnType<typeof useWorkspaceOperations>;
  onImport: () => void;
}) {
  const imported = operations.importOperation;
  const rewrite = operations.rewriteOperation;
  const hasImport = imported.phase !== "idle";
  if (!hasImport && !rewrite) return null;
  const importLabel =
    imported.phase === "running"
      ? "Transcribing"
      : imported.phase === "choosing"
        ? "Choosing files"
        : imported.phase === "ready"
          ? "Transcript ready"
          : imported.phase === "error"
            ? "Import failed"
            : "File selected";
  const rewriteLabel =
    rewrite?.phase === "working"
      ? "Rewriting"
      : rewrite?.phase === "ready"
        ? "Rewrite ready"
        : rewrite?.phase === "error"
          ? "Rewrite failed"
          : "Rewrite draft";
  return (
    <Alert tone="info">
      <div className="flex flex-col gap-2" aria-label="Resumable operations">
        {hasImport && (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="break-words">
              {importLabel}
              {imported.file ? ` · ${imported.file.name}` : ""}
            </span>
            <button className="secondary-button compact" onClick={onImport}>
              Open Bottles
            </button>
          </div>
        )}
        {rewrite && (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="break-words">
              {rewriteLabel} · {rewrite.label}
            </span>
            {!rewrite.visible && (
              <button
                className="secondary-button compact"
                onClick={operations.showRewrite}
              >
                Resume
              </button>
            )}
          </div>
        )}
      </div>
    </Alert>
  );
}
