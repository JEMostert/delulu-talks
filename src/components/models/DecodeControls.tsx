import { speechLanguageCapability } from "../../speechCapabilities";
import { AUTO_LANGUAGE } from "../../data";
import type { AppSettings } from "../../types";

export function DecodeControls({
  settings,
  busy,
  saving,
  onUpdateSettings,
}: {
  settings: AppSettings;
  busy: boolean;
  saving: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const capability = speechLanguageCapability(settings.model);
  return (
    <section
      className="card"
      id="models-decode"
      tabIndex={-1}
      aria-labelledby="models-decode-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">SPEECH DECODING</span>
          <h3 id="models-decode-title">Language & backend defaults</h3>
        </div>
      </div>
      <label className="mt-4 flex items-center justify-between gap-4">
        <span>
          {settings.speechEngine === "redux"
            ? "Language (automatically detected)"
            : "Recognition language"}
        </span>
        <select
          aria-label="Model recognition language"
          value={
            settings.speechEngine === "redux"
              ? AUTO_LANGUAGE
              : settings.language
          }
          disabled={
            busy ||
            saving ||
            settings.speechEngine === "redux" ||
            !capability.canSelectLanguage
          }
          onChange={(event) =>
            onUpdateSettings({ language: event.target.value })
          }
        >
          {(settings.speechEngine === "redux" ||
            capability.canRequestAutomaticLanguage) && (
            <option value={AUTO_LANGUAGE}>Automatic detection</option>
          )}
          {capability.languages.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <dl className="mt-4 text-sm text-muted">
        <dt>Output token limit</dt>
        <dd>4,096 · fixed by the speech backend</dd>
        <dt>Generation</dt>
        <dd>
          {settings.speechEngine === "redux"
            ? "CPU · packed ternary · deterministic decoding"
            : settings.model === "r2t2Mlx"
              ? "MLX · temperature 0"
              : "CUDA · backend defaults (native Transformers disables sampling)"}
        </dd>
      </dl>
      <p className="caption mt-3">
        {settings.speechEngine === "redux"
          ? "Parakeet Redux detects the spoken language automatically, including Dutch and English."
          : settings.language === AUTO_LANGUAGE
            ? "R2T2 detects the spoken language, also when you switch between languages. Token limit, precision and sampling are backend defaults."
            : "Language affects recognition. Token limit, precision and sampling are currently backend defaults; adjustable controls require backend support."}
      </p>
    </section>
  );
}
