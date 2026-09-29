import { DecodeControls } from "../components/models/DecodeControls";
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
      <DecodeControls {...props} />
      <p className="caption">Keyboard: Ctrl/Cmd + Shift + M opens decoding; Ctrl/Cmd + Shift + D opens device diagnostics.</p>
      <div id="models-diagnostics" tabIndex={-1} aria-label="Model device diagnostics"><Diagnostics refreshButtonId="runtime-diagnostics-refresh" /></div>
    </div>
  );
}
