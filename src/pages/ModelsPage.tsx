import { Diagnostics } from "../components/Diagnostics";
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
      <Diagnostics />
    </div>
  );
}
