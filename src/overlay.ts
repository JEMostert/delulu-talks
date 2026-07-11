import { listen } from "@tauri-apps/api/event";
import "./overlay.css";
import type { AudioLevel, DictationStatus } from "./types";

const WAVE_PROFILE = [.14, .22, .34, .48, .66, .82, .94, 1, 1, .94, .82, .66, .48, .34, .22, .14];
const wave = document.querySelector<HTMLElement>(".voice-wave");

if (!wave) throw new Error("Recording wave element is missing");

const bars = WAVE_PROFILE.map(() => {
  const bar = document.createElement("i");
  wave.appendChild(bar);
  return bar;
});

function renderLevel(level: number) {
  const bounded = Math.max(0, Math.min(1, level));
  wave?.setAttribute("aria-valuenow", String(Math.round(bounded * 100)));
  bars.forEach((bar, index) => {
    bar.style.height = `${2 + bounded * (6 + WAVE_PROFILE[index] * 38)}px`;
  });
}

void listen<AudioLevel>("dictation-audio-level", ({ payload }) => renderLevel(payload.level));
void listen<DictationStatus>("dictation-state", ({ payload }) => {
  if (payload.phase !== "listening") renderLevel(0);
});
