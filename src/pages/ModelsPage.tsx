import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { RuntimeSetupSnapshot } from "../components/RuntimeSetupSnapshot";
import { DecodeControls } from "../components/models/DecodeControls";
import { Diagnostics } from "../components/Diagnostics";
import { ModelCachePanel } from "../components/ModelCachePanel";
import {
  SpeechSetup,
  type SpeechSetupProps,
} from "../components/models/SpeechSetup";
import {
  RewriteSetup,
  type RewriteSetupProps,
} from "../components/models/RewriteSetup";

type Props = SpeechSetupProps &
  RewriteSetupProps & {
    focusTarget?: "decode" | "diagnostics" | null;
    onTargetHandled?: () => void;
    onDone?: () => void;
  };
export function ModelsPage(props: Props) {
  const [tab, setTab] = useState("speech");
  const [, setSnapshotPending] = useState(false);
  useEffect(() => {
    if (props.focusTarget) setTab("details");
  }, [props.focusTarget]);
  useEffect(() => {
    if (tab !== "details" || !props.focusTarget) return;
    const target = document.getElementById(`models-${props.focusTarget}`);
    const disclosure = target?.closest("details");
    if (disclosure) disclosure.open = true;
    target?.focus();
    target?.scrollIntoView({ block: "start" });
    props.onTargetHandled?.();
  }, [tab, props.focusTarget, props.onTargetHandled]);
  return (
    <div className="content-stack">
      <div className="setup-tabs" role="tablist" aria-label="Model settings">
        {[
          ["speech", "Speech"],
          ["rewrite", "Rewriting"],
          ["details", "Details"],
        ].map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "speech" && (
        <>
          <SpeechSetup {...props} />
          {props.status.engine === "ready" &&
            props.status.warmup === "complete" && (
              <div className="setup-finished">
                <span>
                  <Check className="inline mr-2" />
                  Ready to dictate
                </span>
                <button className="primary-button" onClick={props.onDone}>
                  Done
                </button>
              </div>
            )}
        </>
      )}
      {tab === "rewrite" && <RewriteSetup {...props} />}
      {tab === "details" && (
        <>
          <details className="disclosure">
            <summary>Runtime</summary>
            <RuntimeSetupSnapshot
              pythonCommand={props.settings.pythonCommand}
              magicModel={props.settings.magicModel}
              busy={props.busy}
              onPending={setSnapshotPending}
            />
          </details>
          <details className="disclosure">
            <summary>Storage</summary>
            <ModelCachePanel
              status={props.status}
              magicStatus={props.magicStatus}
              busy={props.busy || props.saving}
            />
          </details>
          <details className="disclosure">
            <summary>Speech options</summary>
            <DecodeControls {...props} />
          </details>
          <details className="disclosure">
            <summary>Device diagnostics</summary>
            <div
              id="models-diagnostics"
              tabIndex={-1}
              aria-label="Model device diagnostics"
            >
              <Diagnostics refreshButtonId="runtime-diagnostics-refresh" />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
