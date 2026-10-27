import { useCallback } from "react";
import * as ipc from "../ipc";
import { Wordmark } from "../components/Header";
import { Toast } from "../components/Toast";
import { Pearl } from "../pearl/Pearl";
import { errorText, type AppState } from "../state";
import { MicrophoneStep, ModelStep, TypingStep } from "./SetupSteps";

const steps = [
  { title: "Microphone", Body: MicrophoneStep },
  { title: "Talk key", Body: TypingStep },
  { title: "Model", Body: ModelStep },
];

const pearlCaption = ["Say something.", "Hold, talk, let go.", "Almost there."];

export function FirstRun({ state }: { state: AppState }) {
  const { settings, step, setStep, level, modelReady, notice, setNotice } =
    state;
  const dismiss = useCallback(() => setNotice(""), [setNotice]);
  if (!settings) return null;
  const last = step === steps.length - 1;
  const { Body } = steps[step];
  const finish = () =>
    void ipc
      .finishFirstRun()
      .then(() => ipc.getStatus())
      .then(state.setStatus)
      .catch((e) => setNotice(errorText(e)));
  return (
    <main className="setup">
      <aside className="well setup-well">
        <Wordmark />
        <div className="setup-stage">
          <Pearl
            mode={
              step === 0
                ? "micTest"
                : modelReady && last
                  ? "idle"
                  : "needsSetup"
            }
            level={step === 0 ? level : 0}
            flash={modelReady && last ? "success" : null}
            label={step === 0 ? "Microphone level" : "Setup"}
          />
        </div>
        <p className="setup-caption">
          {last && modelReady ? "All set." : pearlCaption[step]}
        </p>
      </aside>
      <section className="setup-panel" aria-labelledby="setup-step">
        <ol
          className="stepper"
          id="setup-step"
          aria-label={`Step ${step + 1} of ${steps.length}`}
        >
          {steps.map(({ title }, i) => (
            <li
              key={title}
              className={i === step ? "now" : i < step ? "done" : ""}
              aria-current={i === step ? "step" : undefined}
            >
              <span className="stepper-bar" />
              <span className="stepper-label">
                {i + 1}. {title}
              </span>
            </li>
          ))}
        </ol>
        <div className="setup-body" key={step}>
          <Body state={state} />
        </div>
        <div className="setup-actions">
          {step > 0 && (
            <button
              type="button"
              className="button quiet"
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="button primary"
            disabled={last && !modelReady}
            onClick={() => (last ? finish() : setStep(step + 1))}
          >
            {last ? "Start talking" : "Continue"}
          </button>
        </div>
      </section>
      <Toast notice={notice} onDismiss={dismiss} />
    </main>
  );
}
