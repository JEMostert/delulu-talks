import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { INITIAL_TALK_STATUS, type TalkStatus } from "../talk";

/** Sonar (Talk) status and actions; one subscription for the whole app. */
export function useTalk() {
  const [status, setStatus] = useState<TalkStatus>(INITIAL_TALK_STATUS);
  useEffect(() => {
    let alive = true;
    let received = false;
    const remove = bridge.onTalkStatus((next) => {
      received = true;
      if (alive) setStatus(next);
    });
    void bridge
      .getTalkStatus()
      .then((next) => {
        // A pushed update may already be newer than this initial read.
        if (alive && !received) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      remove();
    };
  }, []);
  return {
    status,
    start: async (options?: { download?: boolean }) => {
      const next = await bridge.startTalk(options);
      setStatus(next);
      return next;
    },
    stop: async () => setStatus(await bridge.stopTalk()),
    refresh: async () => setStatus(await bridge.getTalkStatus()),
  };
}

export type TalkControls = ReturnType<typeof useTalk>;
