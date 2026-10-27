import { useState } from "react";
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

const ENGINE_TABS = [
  ["speech", "Speech"],
  ["rewrite", "Rewriting"],
  ["details", "Runtime & storage"],
] as const;

type Props = SpeechSetupProps &
  RewriteSetupProps & {
    onDone?: () => void;
  };

/** Engines: set up, load and repair the speech and rewriting models. */
export function ModelsPage(props: Props) {
  const [tab, setTab] = useState<(typeof ENGINE_TABS)[number][0]>("speech");
  // The snapshot probes interpreters, so it only runs once someone looks.
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  return (
    <div className="content-stack">
      <Tabs
        label="Engine sections"
        tabs={ENGINE_TABS}
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
                  Ready. Press your shortcut anywhere.
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
          <Diagnostics />
          <ModelCachePanel
            status={props.status}
            magicStatus={props.magicStatus}
            busy={props.busy || props.saving}
          />
          <DecodeControls {...props} />
          <details
            className="disclosure"
            onToggle={(event) => setRuntimeOpen(event.currentTarget.open)}
          >
            <summary>Runtime details</summary>
            {runtimeOpen && (
              <RuntimeSetupSnapshot
                pythonCommand={props.settings.pythonCommand}
                magicModel={props.settings.magicModel}
                busy={props.busy}
              />
            )}
          </details>
        </>
      )}
    </div>
  );
}
