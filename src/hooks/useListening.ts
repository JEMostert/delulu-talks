import { useEffect } from "react";
import { bridge } from "../bridge";
import { ListenCapture } from "../listenCapture";
import { sharedVoicePlayer } from "./useVoicePlayer";

/**
 * Runs the microphone side of listening sessions the desktop starts. Mounted
 * once outside the error boundary, beside playback, so a session survives
 * page failures and keeps hearing while the window is hidden.
 */
export function useListening(): void {
  useEffect(() => {
    let capture: ListenCapture | null = null;
    const remove = bridge.onListenCommand((command) => {
      if (command.action === "start") {
        // One session at a time: a new one replaces the old cleanly.
        capture?.stop();
        capture = new ListenCapture(
          command.sessionId,
          command.config,
          (event) => bridge.reportListenEvent(event),
          sharedVoicePlayer,
        );
        void capture.start();
        return;
      }
      if (!capture || capture.sessionId !== command.sessionId) return;
      if (command.action === "configure") capture.configure(command.config);
      else if (command.action === "pause") capture.pause();
      else if (command.action === "resume") capture.resume();
      else {
        capture.stop();
        capture = null;
      }
    });
    return () => {
      remove();
      capture?.stop();
      capture = null;
    };
  }, []);
}
