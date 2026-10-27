import { speechLanguageHelp } from "../../speechCapabilities";
import type { AppSettings } from "../../types";

/** How the selected speech model decodes; the language is chosen in Dictation. */
export function DecodeControls({ settings }: { settings: AppSettings }) {
  const cpu = settings.speechEngine !== "large";
  return (
    <section className="card" aria-labelledby="models-decode-title">
      <div className="section-heading">
        <h3 id="models-decode-title">Decoding</h3>
      </div>
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
