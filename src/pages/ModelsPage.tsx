import { useState } from "react";
import { RuntimeSetupSnapshot } from "../components/RuntimeSetupSnapshot";
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
      <RuntimeSetupSnapshot pythonCommand={props.settings.pythonCommand} busy={props.busy} onPending={setSnapshotPending} />
      <SpeechSetup {...props} setupPending={snapshotPending} />
      <RewriteSetup {...props} setupPending={snapshotPending} />
      <ModelCachePanel status={props.status} magicStatus={props.magicStatus} busy={props.busy || props.saving} />
      <Diagnostics />
    </div>
  );
}
