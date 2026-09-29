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
  return (
    <div className="content-stack">
      <SpeechSetup {...props} />
      <RewriteSetup {...props} />
      <ModelCachePanel status={props.status} magicStatus={props.magicStatus} busy={props.busy || props.saving} />
      <Diagnostics />
    </div>
  );
}
