import { Check, ChevronRight, Cpu, Download, Languages, Radio, Sparkles, Zap } from "lucide-react";
import { MODELS } from "../data";
import type { ModelId } from "../types";

export function ModelsPage({ selected, saving, settingUp, onSelect, onSetup }: { selected: ModelId; saving: boolean; settingUp: boolean; onSelect: (id: ModelId) => void; onSetup: () => void }) {
  return (
    <div className="content-stack">
      <section className="page-intro">
        <div><span className="hello-pill"><Sparkles /> Four specialists, zero compromises</span><h2>Pick the brain for the job.</h2><p>Every model runs locally. Choose rich meeting notes, top-tier accuracy, or ultra-fast dictation.</p></div>
        <button className="primary-button" disabled={settingUp} onClick={onSetup}><Download /> {settingUp ? "Preparing model…" : "Set up selected model"}</button>
      </section>

      <div className="model-grid">
        {MODELS.map((model, index) => {
          const active = selected === model.id;
          return (
            <article key={model.id} className={`model-card ${model.accent} ${active ? "selected" : ""}`}>
              <div className="model-card-top"><span className="model-number">0{index + 1}</span>{active && <span className="selected-pill"><Check /> Active</span>}</div>
              <span className={`model-glyph large ${model.accent}`}><span /><span /><span /></span>
              <p className="maker">{model.maker}</p><h3>{model.name}</h3><strong className="model-role">{model.role}</strong><p className="model-description">{model.description}</p>
              <div className="model-specs"><span><Cpu />{model.size}</span><span><Languages />{model.languages}</span><span>{model.id === "nemotron35Streaming" || model.id === "parakeetTdt06bV3" ? <Radio /> : <Zap />}{model.latency}</span></div>
              <div className="mini-tags">{model.badges.map((badge) => <span key={badge}>{badge}</span>)}</div>
              <button disabled={active || saving || settingUp} className={active ? "model-button active" : "model-button"} onClick={() => onSelect(model.id)}>{active ? "Currently selected" : <>Use this model <ChevronRight /></>}</button>
            </article>
          );
        })}
      </div>

      <div className="info-banner"><Zap /><div><strong>First run takes a minute.</strong><p>Model weights are downloaded once into a private app environment, then stay on your machine.</p></div></div>
    </div>
  );
}
