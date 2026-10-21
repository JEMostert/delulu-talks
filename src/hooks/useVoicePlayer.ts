import { useEffect } from "react";
import { bridge } from "../bridge";
import { createVoicePlayer } from "../voicePlayer";

/**
 * Plays synthesized speech the desktop sends. Mounted once at the app root, so
 * speech continues on every page and while the window is hidden in the tray.
 */
export function useVoicePlayer(): void {
  useEffect(() => {
    const player = createVoicePlayer((event) =>
      bridge.reportVoicePlayback(event),
    );
    const removePlay = bridge.onVoicePlay((chunk) => player.play(chunk));
    const removeStop = bridge.onVoiceStopPlayback((utteranceId) =>
      player.stop(utteranceId),
    );
    return () => {
      removePlay();
      removeStop();
      player.dispose();
    };
  }, []);
}
