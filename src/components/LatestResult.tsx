import { useEffect, useState } from "react";
import { Check, Copy, FileAudio, History, Mic, X } from "lucide-react";
import { deliveredText } from "../transcriptText";
import { relativeTime } from "../statusLabels";
import type { TranscriptRecord } from "../types";

/** The newest transcript, floating under the controller on the home screen. */
export function LatestResult({
  record,
  onCopy,
  onOpen,
}: {
  record: TranscriptRecord;
  onCopy: () => Promise<boolean>;
  onOpen: () => void;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setCopied(false);
  }, [record.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const text = deliveredText(record).trim();
  if (dismissed === record.id || !text) return null;
  const seconds = Math.round(record.durationMs / 1000);
  const Source = record.source === "file" ? FileAudio : Mic;
  return (
    <section
      key={record.id}
      className="latest-result"
      aria-label="Latest transcript"
    >
      <header>
        <Source aria-hidden="true" />
        <span>
          Latest · {relativeTime(record.createdAt, now)}
          {seconds > 0 && ` · ${seconds}s`}
        </span>
      </header>
      <p title={text.length > 240 ? text.slice(0, 600) : undefined}>{text}</p>
      <div className="latest-actions">
        <button
          aria-label={copied ? "Copied" : "Copy latest transcript"}
          title={copied ? "Copied" : "Copy"}
          onClick={() =>
            void onCopy().then((ok) => {
              if (ok) setCopied(true);
            })
          }
        >
          {copied ? <Check /> : <Copy />}
        </button>
        <button
          aria-label="Open in history"
          title="Open in history"
          onClick={onOpen}
        >
          <History />
        </button>
        <button
          aria-label="Hide latest transcript"
          title="Hide"
          onClick={() => setDismissed(record.id)}
        >
          <X />
        </button>
      </div>
    </section>
  );
}
