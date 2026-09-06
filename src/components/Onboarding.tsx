import { useState } from "react";
import { ArrowRight, AudioLines, Keyboard, ShieldCheck } from "lucide-react";
import { Modal } from "./ui";
import type { AppSettings } from "../types";

export function Onboarding({
  settings,
  saving,
  onFinish,
}: {
  settings: AppSettings;
  saving: boolean;
  onFinish: (openModels: boolean, acceptLicense: boolean) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  return (
    <Modal
      title={
        step === 0
          ? "A little less typing starts here."
          : "Your voice, wherever you write."
      }
      onClose={() => void onFinish(false, settings.modelLicenseAccepted)}
      busy={saving}
      footer={
        <>
          <button
            className="text-button"
            disabled={saving}
            onClick={() =>
              step === 0
                ? void onFinish(false, settings.modelLicenseAccepted)
                : setStep(0)
            }
          >
            {step === 0 ? "Explore first" : "Back"}
          </button>
          <button
            className="primary-button"
            disabled={saving}
            onClick={() =>
              step === 0
                ? setStep(1)
                : void onFinish(true, settings.modelLicenseAccepted)
            }
          >
            {step === 0 ? "Show me how" : "Set up my engine"}
            <ArrowRight />
          </button>
        </>
      }
    >
      <div className="welcome-mark">
        <AudioLines />
      </div>
      {step === 0 ? (
        <>
          <p className="welcome-copy">
            Meet Delulu Talks. A quiet place for your thoughts, and a shortcut
            that turns them into words.
          </p>
          <div className="welcome-feature">
            <ShieldCheck />
            <div>
              <strong>At home on your device</strong>
              <p>
                Speech and writing models run locally. You choose whether to
                save transcript history.
              </p>
            </div>
          </div>
          <div className="welcome-feature">
            <AudioLines />
            <div>
              <strong>As natural as talking</strong>
              <p>
                Keep your original speech, clean it up, or give it a little
                polish with Magic.
              </p>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="welcome-feature">
            <Keyboard />
            <div>
              <strong>One shortcut, anywhere</strong>
              <p>
                Use {settings.shortcut.replace("Super", "Meta")} in the app
                you’re writing in. Supported desktops let you hold to talk;
                other desktops use press to start and stop.
              </p>
            </div>
          </div>
          <p>
            First, we’ll help you choose a model that fits your machine. Setup
            needs Python and an internet connection for downloads. Once
            installed, inference stays local.
          </p>
          <p className="caption">
            You can change your microphone, shortcut, and writing style in
            Settings at any time.
          </p>
        </>
      )}
    </Modal>
  );
}
