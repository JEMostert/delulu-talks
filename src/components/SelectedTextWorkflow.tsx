import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import type { SelectedTextState } from "../selectedText";
import type { MagicStatus } from "../types";
import { RewriteDialog } from "./RewriteDialog";
import { Modal } from "./ui";

export function SelectedTextWorkflow({status,onSetup}: {status:MagicStatus;onSetup:()=>void}) {
  const [state,setState] = useState<SelectedTextState | null>(null);
  const [preferences,setPreferences] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(null);
  const [notice,setNotice] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let received = false;
    const unsubscribe = bridge.onSelectedTextState((next) => {received = true;if(alive) setState(next);});
    void bridge.getSelectedTextState().then((next) => {if(alive && !received) setState(next);}).catch((reason) => {if(alive) setError(String(reason));});
    return () => {alive = false;unsubscribe();};
  },[]);
  return <>
    <button className="secondary-button" onClick={() => setPreferences(true)}>Selected-text rewrite</button>
    {state?.error && !preferences && <span role="alert" className="field-error">{state.error}</span>}
    {notice && <span role="status" className="caption">{notice}</span>}
    {preferences && <Modal title="Selected text from another application" busy={busy} onClose={() => setPreferences(false)} footer={<button className="secondary-button" disabled={busy} onClick={() => setPreferences(false)}>Close</button>}>
      <p>Enable the shortcut explicitly, select text in another application, then press Ctrl+Shift+R. Delulu captures that selection and opens an original → rewrite preview. Applying it is a separate action.</p>
      <p className="caption mt-3">Current native support: Linux X11 with xdotool and an explicitly recognized text editor (VS Code/Codium, Kate/KWrite, Gedit/Xed, Mousepad/Leafpad, Geany/Pluma or Sublime). Terminal and unknown applications use manual copy. Wayland, Windows and macOS use the editor workflow or manually entered text. Native behavior has not been verified. Rich clipboard content is left untouched; capture refuses when it cannot preserve the original formats.</p>
      <p className="caption mt-3">The shortcut temporarily copies the selection and restores your plain-text clipboard if it still belongs to this operation. Replacement returns to the captured window and copies its selection again to check for changes before sending Ctrl+V. Focus or selection mismatches leave the preview available for manual copy. No command is executed and Enter is never sent.</p>
      {(error || state?.error) && <p role="alert" className="field-error">{error ?? state?.error}</p>}
      <button className="primary-button mt-3" disabled={busy || !state || (!state.supported && !state.enabled)} onClick={async () => {
        setBusy(true);setError(null);
        try {setState(await bridge.enableSelectedText(!state!.enabled));}
        catch(reason) {setError(reason instanceof Error ? reason.message : String(reason));}
        finally {setBusy(false);}
      }}>{state?.enabled ? "Disable capture shortcut" : "Enable selection capture shortcut"}</button>
    </Modal>}
    {state?.session && <RewriteDialog key={state.session.id} title="Rewrite captured selection" description={`Captured from ${state.session.destination}. Compare the complete original and preview. Applying attempts replacement in that window only after its selected text is checked again.`}
      text={state.session.text} baseline={state.session.text} originalText={state.session.text} status={status} onRewrite={bridge.rewriteMagic} onCancelRewrite={bridge.cancelRewrite} onSetup={onSetup}
      onClose={() => {void bridge.discardSelectedText(state.session!.id).catch((reason) => setError(String(reason)));}}
      onApply={async (result) => {
        try {await bridge.replaceSelectedText(state.session!.id,result.text);setNotice("Replacement attempted — verify the destination editor.");return true;}
        catch(reason) {throw new Error(`${reason instanceof Error ? reason.message : String(reason)} Use Copy preview for manual delivery.`);}
      }}
    />}
  </>;
}
