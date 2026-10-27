import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import type { VoiceSpeakRequest, VoiceStatus } from "../voice";

export const INITIAL_VOICE_STATUS: VoiceStatus = {
  engine: "unloaded",
  phase: "idle",
  message: "Checking Siren…",
  model: null,
  current: null,
  queued: 0,
  recent: [],
  bridge: {
    enabled: false,
    listening: false,
    clients: 0,
    endpoint: null,
    error: null,
  },
};

/** Spoken output status and actions; one subscription for the whole app. */
export function useVoice() {
  const [status, setStatus] = useState<VoiceStatus>(INITIAL_VOICE_STATUS);
  useEffect(() => {
    let alive = true;
    let received = false;
    const remove = bridge.onVoiceStatus((next) => {
      received = true;
      if (alive) setStatus(next);
    });
    void bridge
      .getVoiceStatus()
      .then((next) => {
        // A pushed update may already be newer than this initial read.
        if (alive && !received) setStatus(next);
      })
      .catch(() => {
        if (alive && !received)
          setStatus((previous) => ({
            ...previous,
            message: "Siren is unavailable in this window",
          }));
      });
    return () => {
      alive = false;
      remove();
    };
  }, []);
  const speaking =
    status.phase !== "idle" || status.current !== null || status.queued > 0;
  return {
    status,
    speaking,
    setup: () => bridge.setupVoice(),
    cancelSetup: () => bridge.cancelVoiceSetup(),
    load: () => bridge.loadVoice(),
    unload: () => bridge.unloadVoice(),
    speak: (request: VoiceSpeakRequest) => bridge.speak(request),
    stop: () => bridge.stopSpeaking(),
    speakClipboard: () => bridge.speakClipboard(),
    chooseReference: () => bridge.chooseVoiceReference(),
    removeReference: () => bridge.removeVoiceReference(),
    agentSetup: () => bridge.getVoiceAgentSetup(),
    installSkill: () => bridge.installVoiceSkill(),
  };
}

export type VoiceControls = ReturnType<typeof useVoice>;
