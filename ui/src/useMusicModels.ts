import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";
import { errorText } from "./state";

/** The music models and their download, kept current by the app's events. */
export function useMusicModels() {
  const [models, setModels] = useState<ipc.MusicModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    ipc
      .getMusicModel()
      .then((m) => active && setModels(m))
      .catch((e) => active && setError(errorText(e)));
    const off = ipc.onMusicModel((m) => {
      if (!active) return;
      setModels(m);
      setError(null);
    });
    return () => {
      active = false;
      void off.then((f) => f());
    };
  }, []);

  const run = useCallback(
    async (action: () => Promise<ipc.MusicModel | void>) => {
      setError(null);
      try {
        const next = await action();
        if (next) setModels(next);
      } catch (e) {
        setError(errorText(e));
      }
    },
    [],
  );

  return { models, error: error ?? models?.error ?? null, run };
}

export const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Download progress over all models of the download in progress, 0–100. */
export function downloadPercent(models: ipc.MusicModel | null): number {
  if (!models?.totalBytes) return 0;
  return Math.round((models.doneBytes / models.totalBytes) * 100);
}
