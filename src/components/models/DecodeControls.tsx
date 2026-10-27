import {
  speechLanguageCapability,
  speechLanguageHelp,
} from "../../speechCapabilities";
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
  const capability = speechLanguageCapability(
    settings.speechEngine,
    settings.model,
  );
  const cpu = settings.speechEngine !== "large";
  return (
    <section className="card" aria-labelledby="models-decode-title">
      <div className="section-heading">
        <h3 id="models-decode-title">Decoding</h3>
      </div>
      <label className="mt-4 flex items-center justify-between gap-4">
        <span>Language</span>
        <select
          aria-label="Model recognition language"
          value={settings.language}
          disabled={busy || saving || !capability.canSelectLanguage}
          onChange={(event) =>
            onUpdateSettings({ language: event.target.value })
          }
        >
          {capability.canRequestAutomaticLanguage && (
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
        <dt>{cpu ? "Long recordings" : "Output token limit"}</dt>
        <dd>
          {cpu
            ? `Split at quiet moments into pieces of up to ${settings.speechEngine === "small" ? 30 : 60} seconds`
            : "4,096, fixed by the backend"}
        </dd>
        <dt>Generation</dt>
        <dd>
          {cpu
            ? "CPU · INT8 · greedy decoding"
            : settings.model === "r2t2Mlx"
              ? "MLX · temperature 0"
              : "CUDA · no sampling"}
        </dd>
      </dl>
      <p className="caption mt-3">
        {speechLanguageHelp(settings.speechEngine, settings.language)}
      </p>
    </section>
  );
}
