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
      ? "Import running"
      : imported.phase === "choosing"
        ? "Choosing import"
        : imported.phase === "ready"
          ? "Import result ready"
          : imported.phase === "error"
            ? "Import needs attention"
            : "Import selected";
  const rewriteLabel =
    rewrite?.phase === "working"
      ? "Rewrite running"
      : rewrite?.phase === "ready"
        ? "Rewrite preview ready"
        : rewrite?.phase === "error"
          ? "Rewrite needs attention"
          : "Rewrite draft saved for this session";
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
              Open Audio files
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
                Resume rewrite
              </button>
            )}
          </div>
        )}
      </div>
    </Alert>
  );
}
