import { useState } from "react";
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

export function ModelsPage(props: SpeechSetupProps & RewriteSetupProps) {
  const [snapshotPending, setSnapshotPending] = useState(true);
  return (
    <div className="content-stack">
      <RuntimeSetupSnapshot pythonCommand={props.settings.pythonCommand} magicModel={props.settings.magicModel} busy={props.busy} onPending={setSnapshotPending} />
      <SpeechSetup {...props} setupPending={snapshotPending} />
      <RewriteSetup {...props} setupPending={snapshotPending} />
      <ModelCachePanel status={props.status} magicStatus={props.magicStatus} busy={props.busy || props.saving} />
      <DecodeControls {...props} />
      <p className="caption">Keyboard: Ctrl/Cmd + Shift + M opens decoding; Ctrl/Cmd + Shift + D opens device diagnostics.</p>
      <div id="models-diagnostics" tabIndex={-1} aria-label="Model device diagnostics"><Diagnostics refreshButtonId="runtime-diagnostics-refresh" /></div>
    </div>
  );
}
