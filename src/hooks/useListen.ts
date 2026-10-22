import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import type { ListenStatus } from "../listening";

export const INITIAL_LISTEN_STATUS: ListenStatus = {
  session: null,
  recent: [],
  capturing: false,
  message: "Not listening",
};

/** Listening session status and actions; one subscription for the whole app. */
export function useListen() {
  const [status, setStatus] = useState<ListenStatus>(INITIAL_LISTEN_STATUS);
  useEffect(() => {
    let alive = true;
    let received = false;
    const remove = bridge.onListenStatus((next) => {
      received = true;
      if (alive) setStatus(next);
    });
    void bridge
      .getListenStatus()
      .then((next) => {
        if (alive && !received) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      remove();
    };
  }, []);
  const state = status.session?.state;
  const active =
    state === "starting" || state === "listening" || state === "paused";
  return {
    status,
    active,
    start: async () => setStatus(await bridge.startListening()),
    stop: async () => setStatus(await bridge.stopListening()),
    installSkill: () => bridge.installVoiceSkill(),
  };
}

export type ListenControls = ReturnType<typeof useListen>;
