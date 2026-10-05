import { useRef, type FormEvent } from "react";
import App from "./App";
import { useWorkspace } from "./hooks/useWorkspace";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";
import { RecoveryDrafts } from "./rendererRecovery";
import { useRenderingMode } from "./hooks/useRenderingMode";

/** Capture and pending saves survive a failure in the presentation subtree. */
export function WorkspaceRoot() {
  useRenderingMode();
  const workspace = useWorkspace();
  const drafts = useRef(new RecoveryDrafts());
  const fieldIds = useRef(new WeakMap<HTMLElement, string>());
  const nextId = useRef(0);

  function rememberEdit(event: FormEvent<HTMLDivElement>) {
    const field = event.target;
    if (
      !(field instanceof HTMLTextAreaElement) &&
      !(field instanceof HTMLInputElement && field.type === "text")
    )
      return;
    if (field.readOnly || field.disabled) return;
    let key = fieldIds.current.get(field);
    if (!key) {
      key = String(++nextId.current);
      fieldIds.current.set(field, key);
    }
    const label =
      field.getAttribute("aria-label") ||
      field.labels?.[0]?.textContent?.trim() ||
      "Text edit";
    drafts.current.remember(key, label.slice(0, 120), field.value);
  }

  return (
    <div className="contents" onInputCapture={rememberEdit}>
      <RendererErrorBoundary
        drafts={drafts.current}
        localSavePending={workspace.saving}
      >
        <App workspace={workspace} />
      </RendererErrorBoundary>
    </div>
  );
}
