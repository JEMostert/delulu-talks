import { ArrowLeft, ArrowRight, AudioLines, Keyboard, ShieldCheck, WandSparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppSettings } from "../types";

const STEPS = [
  {
    icon: AudioLines,
    eyebrow: "WELCOME TO DELULU TALKS",
    title: "Your voice, ready wherever you type",
    body: "Delulu Talks runs locally and turns a held shortcut into polished text at the cursor. Recordings are deleted after transcription; your transcript history stays on this machine.",
  },
  {
    icon: Keyboard,
    eyebrow: "ONE SHORTCUT",
    title: "Hold, speak, release",
    body: "Hold the Windows key (Meta) + Z while speaking. Release to transcribe. If Magic is enabled, the local Qwen model rewrites the result before it is copied and pasted back into the app you were using.",
  },
  {
    icon: WandSparkles,
    eyebrow: "LOCAL ENGINES",
    title: "Choose quality that fits your machine",
    body: "The next screen lets you choose and install CrisperWhisper. Medium is the recommended everyday model. Model files can be large, so Delulu Talks downloads them only after you approve the license.",
  },
] as const;

export function Onboarding({ settings, saving, onFinish }: { settings: AppSettings; saving: boolean; onFinish: (openModels: boolean, acceptLicense: boolean) => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [accepted, setAccepted] = useState(settings.modelLicenseAccepted);
  const current = STEPS[step];
  const Icon = current.icon;
  useEffect(() => setAccepted(settings.modelLicenseAccepted), [settings.modelLicenseAccepted]);

  return <div className="onboarding-backdrop">
    <section className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <button className="onboarding-skip icon-button" aria-label="Skip setup intro" disabled={saving} onClick={() => void onFinish(false, accepted)}><X /></button>
      <div className="onboarding-art" aria-hidden="true"><span>DELULU</span><Icon /><i>LOCAL-FIRST VOICE TOOLS</i></div>
      <div className="onboarding-content">
        <p className="eyebrow">{current.eyebrow}</p>
        <h2 id="onboarding-title">{current.title}</h2>
        <p>{current.body}</p>
        {step === 1 && <div className="onboarding-flow"><kbd>Meta + Z</kbd><ArrowRight /><span>Speech</span><ArrowRight /><span>Magic</span><ArrowRight /><span>Paste</span></div>}
        {step === 2 && <label className="onboarding-license"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><ShieldCheck /><span><strong>Accept Nyra’s model-weight license</strong><small>Standard CrisperWhisper weights are for non-commercial research use. The app itself remains MIT licensed.</small><a href="https://huggingface.co/nyralabs/CrisperWhisper2.0_large/blob/main/LICENSE.md" target="_blank" rel="noreferrer">Review license</a></span></label>}
        <div className="onboarding-dots" aria-label={`Step ${step + 1} of ${STEPS.length}`}>{STEPS.map((_, index) => <i key={index} className={index === step ? "active" : ""} />)}</div>
        <footer>
          {step > 0 ? <button className="secondary-button" disabled={saving} onClick={() => setStep(step - 1)}><ArrowLeft /> Back</button> : <button className="text-button" disabled={saving} onClick={() => void onFinish(false, accepted)}>Skip for now</button>}
          {step < STEPS.length - 1
            ? <button className="primary-button" onClick={() => setStep(step + 1)}>Continue <ArrowRight /></button>
            : <button className="primary-button" disabled={saving || !accepted} onClick={() => void onFinish(true, accepted)}>{saving ? "Saving…" : "Choose my model"} <ArrowRight /></button>}
        </footer>
      </div>
    </section>
  </div>;
}
