import { useEffect } from "react";
import { bridge } from "../bridge";
import { createVoicePlayer, type VoicePlayer } from "../voicePlayer";

let shared: VoicePlayer | null = null;

/** The mounted player, for listening sessions' barge-in and echo reference. */
export const sharedVoicePlayer = (): VoicePlayer | null => shared;

/**
 * Plays synthesized speech the desktop sends. Mounted once at the app root, so
 * speech continues on every page and while the window is hidden in the tray.
 */
export function useVoicePlayer(): void {
  useEffect(() => {
    const player = createVoicePlayer((event) =>
      bridge.reportVoicePlayback(event),
    );
    shared = player;
    const removePlay = bridge.onVoicePlay((chunk) => player.play(chunk));
    const removeStop = bridge.onVoiceStopPlayback((utteranceId) =>
      player.stop(utteranceId),
    );
    return () => {
      removePlay();
      removeStop();
      if (shared === player) shared = null;
      player.dispose();
    };
  }, []);
}
