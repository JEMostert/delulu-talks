import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Tabs } from "../components/ui";
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

const MODEL_TABS = [
  ["speech", "Speech"],
  ["rewrite", "Rewriting"],
  ["details", "Runtime & storage"],
] as const;

type Props = SpeechSetupProps &
  RewriteSetupProps & {
    focusTarget?: "decode" | "diagnostics" | null;
    onTargetHandled?: () => void;
    onDone?: () => void;
  };
export function ModelsPage(props: Props) {
  const [tab, setTab] = useState<(typeof MODEL_TABS)[number][0]>("speech");
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
      <Tabs
        label="Model settings"
        tabs={MODEL_TABS}
        value={tab}
        onChange={setTab}
      />
      {tab === "speech" && (
        <>
          <SpeechSetup {...props} />
          {props.status.engine === "ready" &&
            props.status.warmup === "complete" && (
              <div className="setup-finished">
                <span className="flex items-center gap-2">
                  <Check className="text-success" />
                  Ready to dictate — press your shortcut anywhere.
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
          <section className="model-section">
            <h3>Runtime</h3>
            <RuntimeSetupSnapshot
              pythonCommand={props.settings.pythonCommand}
              magicModel={props.settings.magicModel}
              busy={props.busy}
              onPending={setSnapshotPending}
            />
          </section>
          <section className="model-section">
            <h3>Storage</h3>
            <ModelCachePanel
              status={props.status}
              magicStatus={props.magicStatus}
              busy={props.busy || props.saving}
            />
          </section>
          <section className="model-section">
            <h3>Speech options</h3>
            <DecodeControls {...props} />
          </section>
          <section className="model-section">
            <h3>Device diagnostics</h3>
            <div
              id="models-diagnostics"
              tabIndex={-1}
              aria-label="Model device diagnostics"
            >
              <Diagnostics refreshButtonId="runtime-diagnostics-refresh" />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
