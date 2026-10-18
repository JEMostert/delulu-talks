import { Check, Feather, Gauge, Sparkles } from "lucide-react";
import { SPEECH_TIERS } from "../../data";
import { supportedSpeechLanguage } from "../../speechCapabilities";
import type { AppSettings, SpeechTier } from "../../types";

const ICONS = { small: Feather, medium: Gauge, large: Sparkles } as const;

/** Small, Medium or Large speech. Choosing one saves it; nothing downloads until setup. */
export function SpeechTierPicker({
  settings,
  largeAvailable,
  disabled,
  onSelect,
}: {
  settings: AppSettings;
  largeAvailable: boolean;
  disabled: boolean;
  onSelect: (patch: Partial<AppSettings>) => void;
}) {
  const select = (tier: SpeechTier) =>
    settings.speechEngine !== tier &&
    onSelect({
      speechEngine: tier,
      language: supportedSpeechLanguage(
        tier,
        settings.model,
        settings.language,
      ),
    });
  return (
    <div className="engine-choice" role="radiogroup" aria-label="Speech model">
      {SPEECH_TIERS.map((tier) => {
        const Icon = ICONS[tier.id];
        const unavailable = tier.id === "large" && !largeAvailable;
        return (
          <button
            key={tier.id}
            role="radio"
            aria-checked={settings.speechEngine === tier.id}
            className="engine-option"
            disabled={disabled || unavailable}
            onClick={() => select(tier.id)}
          >
            <Icon aria-hidden="true" />
            <span>
              <strong>
                {tier.name} · {tier.model}
                {"recommended" in tier && tier.recommended && (
                  <span className="tier-tag">Recommended</span>
                )}
              </strong>
              <small>
                {tier.summary} {tier.detail}
              </small>
              <small className="tier-meta">
                {unavailable
                  ? "Not available on this computer"
                  : `${tier.download} download · ${tier.hardware}`}
              </small>
            </span>
            {settings.speechEngine === tier.id && (
              <Check className="engine-check" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}
