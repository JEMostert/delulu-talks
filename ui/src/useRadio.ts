import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";

/** The radio's state and when it arrived, so a page can run its clock on. */
export type RadioView = { radio: ipc.Radio; at: number };

/**
 * One subscription to Delulu FM, shared by the rail's mini player and the
 * Delulu FM page. Nothing is fetched while the radio is turned off in
 * Settings. `poll` also corrects the playback clock every few seconds, for a
 * page that shows the position; events carry every real change.
 */
export function useRadio(
  enabled: boolean,
  poll: boolean,
  onError: (message: string) => void,
) {
  const [view, setView] = useState<RadioView>();
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const apply = useCallback(
    (radio: ipc.Radio) => setView({ radio, at: Date.now() }),
    [],
  );

  useEffect(() => {
    if (!enabled) {
      setView(undefined);
      return;
    }
    let active = true;
    const unlisten: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      p.then((fn) => (active ? unlisten.push(fn) : fn())).catch(() => {});
    keep(ipc.onRadio((r) => active && apply(r)));
    keep(ipc.onRadioError((m) => active && onError(`Delulu FM: ${m}`)));
    ipc
      .getRadio()
      .then((r) => active && apply(r))
      .catch((e) => active && onError(String(e)));
    return () => {
      active = false;
      unlisten.forEach((fn) => fn());
    };
  }, [enabled, apply, onError]);

  useEffect(() => {
    if (!enabled || !poll) return;
    let active = true;
    const timer = setInterval(() => {
      ipc
        .getRadio()
        .then((r) => active && apply(r))
        .catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, poll, apply]);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      apply(await ipc.checkRadio());
    } catch (e) {
      onError(String(e));
    } finally {
      setChecking(false);
    }
  }, [apply, onError]);

  const act = useCallback(
    async (call: () => Promise<ipc.Radio>) => {
      setBusy(true);
      try {
        apply(await call());
      } catch (e) {
        onError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [apply, onError],
  );

  const playing = view?.radio.playing;
  const toggle = useCallback(() => {
    if (playing !== undefined)
      void act(playing ? ipc.radioPause : ipc.radioPlay);
  }, [act, playing]);
  const skip = useCallback(() => void act(ipc.radioSkip), [act]);

  return { view, apply, check, checking, act, busy, toggle, skip };
}

export type RadioState = ReturnType<typeof useRadio>;
