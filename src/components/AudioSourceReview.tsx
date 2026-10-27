import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";

type Props = { path: string; name: string; onClose: () => void };

export function AudioSourceReview({ path, name, onClose }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const disposeRef = useRef<() => void>(() => {});
  const [url, setUrl] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string>();
  const [playbackError, setPlaybackError] = useState<string>();
  const [waveformError, setWaveformError] = useState<string>();
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let disposed = false;
    let objectUrl: string | undefined;
    let context: AudioContext | undefined;
    let analyser: AnalyserNode | undefined;
    let samples: Uint8Array<ArrayBuffer> | undefined;
    let frame: number | undefined;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    setUrl(undefined);
    setLoading(true);
    setReadError(undefined);
    setPlaybackError(undefined);
    setWaveformError(undefined);
    setReducedMotion(motion.matches);

    const stopDrawing = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    };
    const draw = () => {
      frame = undefined;
      if (disposed || audio.paused || motion.matches || !analyser || !samples)
        return;
      const canvas = canvasRef.current;
      const painter = canvas?.getContext("2d");
      if (canvas && painter) {
        analyser.getByteTimeDomainData(samples);
        painter.clearRect(0, 0, canvas.width, canvas.height);
        painter.strokeStyle = getComputedStyle(canvas).color;
        painter.lineWidth = 2;
        painter.beginPath();
        for (let i = 0; i < samples.length; i++) {
          const x = (i * canvas.width) / (samples.length - 1);
          const y = (samples[i] / 255) * canvas.height;
          if (i === 0) painter.moveTo(x, y);
          else painter.lineTo(x, y);
        }
        painter.stroke();
      }
      frame = requestAnimationFrame(draw);
    };
    const onPlay = async () => {
      if (disposed || motion.matches) return;
      try {
        if (!context) {
          context = new AudioContext();
          analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          samples = new Uint8Array(analyser.fftSize);
          const source = context.createMediaElementSource(audio);
          source.connect(analyser);
          analyser.connect(context.destination);
        }
        await context.resume();
        if (disposed || audio.paused || motion.matches) return;
        stopDrawing();
        draw();
      } catch {
        if (!disposed)
          setWaveformError(
            "The playback waveform is unavailable in this browser.",
          );
      }
    };
    const onPlaybackError = () => {
      stopDrawing();
      if (!disposed)
        setPlaybackError(
          "This format can’t play here, but it can still be transcribed.",
        );
    };
    const onMotionChange = () => {
      setReducedMotion(motion.matches);
      stopDrawing();
      if (!motion.matches && !audio.paused) void onPlay();
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", stopDrawing);
    audio.addEventListener("ended", stopDrawing);
    audio.addEventListener("error", onPlaybackError);
    motion.addEventListener("change", onMotionChange);

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      stopDrawing();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", stopDrawing);
      audio.removeEventListener("ended", stopDrawing);
      audio.removeEventListener("error", onPlaybackError);
      motion.removeEventListener("change", onMotionChange);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (context) void context.close().catch(() => {});
    };
    disposeRef.current = dispose;
    void bridge
      .loadAudioSource(path)
      .then(({ bytes, mime }) => {
        if (disposed) return;
        if (bytes.byteLength > 32 * 1024 * 1024)
          throw new Error("Audio review supports source files up to 32 MiB.");
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: mime }));
        setUrl(objectUrl);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setReadError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      });
    return dispose;
  }, [path]);

  return (
    <section
      className="rounded-panel border border-line bg-surface p-4 flex flex-col gap-3"
      aria-label={`Listen to ${name}`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 break-all">{name}</h3>
        <button
          className="secondary-button"
          onClick={() => {
            disposeRef.current();
            onClose();
          }}
        >
          Close
        </button>
      </div>
      {loading && <p role="status">Loading…</p>}
      {readError && (
        <p role="alert" className="field-error">
          Could not read the source audio: {readError}
        </p>
      )}
      <audio
        ref={audioRef}
        src={url}
        controls
        preload="metadata"
        className="w-full"
        aria-label={`Play ${name}`}
      />
      {playbackError && (
        <p role="alert" className="field-error">
          {playbackError}
        </p>
      )}
      {!reducedMotion && (
        <canvas
          ref={canvasRef}
          width={640}
          height={96}
          className="w-full rounded-lg bg-black/10 text-accent"
          aria-hidden="true"
        />
      )}
      {waveformError && !reducedMotion && (
        <p className="text-xs text-muted">{waveformError}</p>
      )}
    </section>
  );
}
