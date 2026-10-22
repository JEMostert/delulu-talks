import type { ReactNode } from "react";
import { Check } from "lucide-react";

/** One numbered step of the Voice page; a finished step shows a check. */
export function VoiceStep({
  number,
  title,
  description,
  done = false,
  optional = false,
  children,
}: {
  number: number;
  title: string;
  description: string;
  done?: boolean;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`voice-step ${done ? "done" : ""}`}
      aria-labelledby={`voice-step-${number}`}
    >
      <header className="voice-step-head">
        <span
          className="voice-step-number"
          aria-label={done ? `Step ${number}, done` : `Step ${number}`}
        >
          {done ? <Check aria-hidden="true" /> : number}
        </span>
        <div>
          <h2 id={`voice-step-${number}`}>
            {title}
            {optional && <span className="voice-step-optional">Optional</span>}
          </h2>
          <p>{description}</p>
        </div>
      </header>
      <div className="voice-step-body">{children}</div>
    </section>
  );
}
