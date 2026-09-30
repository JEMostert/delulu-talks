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
    <div
      className="px-6 pt-3 max-[900px]:px-4"
      aria-label="Resumable operations"
    >
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 text-sm"
        role="status"
      >
        {hasImport && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="break-words">
              {importLabel}
              {imported.file ? ` · ${imported.file.name}` : ""}
            </span>
            <button className="secondary-button" onClick={onImport}>
              Resume import in Audio files
            </button>
          </div>
        )}
        {rewrite && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-words">
              {rewriteLabel} · {rewrite.label}
            </span>
            {!rewrite.visible && (
              <button
                className="secondary-button"
                onClick={operations.showRewrite}
              >
                Resume rewrite
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
