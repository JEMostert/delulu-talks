import type { ReactNode } from "react";

/** A voice setup section. */
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
