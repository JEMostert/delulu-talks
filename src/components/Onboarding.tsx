import { Cpu, X } from "lucide-react";
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
  return (
    <section className="setup-notice" aria-label="First-run setup">
      <Cpu />
      <div>
        <strong>Set up local dictation</strong>
        <p>
          Select your microphone below, then install a speech model. You can
          configure the app while setup is pending.
        </p>
      </div>
      <button
        className="secondary-button"
        disabled={saving}
        onClick={() => void onFinish(true, settings.modelLicenseAccepted)}
      >
        Set up engine
      </button>
      <button
        className="icon-button"
        aria-label="Dismiss setup"
        disabled={saving}
        onClick={() => void onFinish(false, settings.modelLicenseAccepted)}
      >
        <X />
      </button>
    </section>
  );
}
