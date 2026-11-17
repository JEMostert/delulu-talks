import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";
import { errorText } from "./state";

/** A failed action, and the models it was for (none: not about one model). */
export type MusicFailure = { text: string; ids: string[] };

/** The error to show on one model's row: a failed action on it, or its own failed download. */
export function musicErrorFor(
  models: ipc.MusicModel | null,
  failure: MusicFailure | null,
  id: string,
): string | null {
  if (failure?.ids.includes(id)) return failure.text;
  return models?.models.find((m) => m.id === id)?.error ?? null;
}

/** An error that belongs to no model's row, such as music not being available here. */
export function musicGeneralError(
  models: ipc.MusicModel | null,
  failure: MusicFailure | null,
): string | null {
  if (failure && failure.ids.length === 0) return failure.text;
  if (!models?.error || models.models.some((m) => m.error)) return null;
  return models.error;
}

/** The music models and their download, kept current by the app's events. */
export function useMusicModels() {
  const [models, setModels] = useState<ipc.MusicModel | null>(null);
  const [failure, setFailure] = useState<MusicFailure | null>(null);

  useEffect(() => {
    let active = true;
    ipc
      .getMusicModel()
      .then((m) => active && setModels(m))
      .catch((e) => active && setFailure({ text: errorText(e), ids: [] }));
    const off = ipc.onMusicModel((m) => {
      if (!active) return;
      setModels(m);
      setFailure(null);
    });
    return () => {
      active = false;
      void off.then((f) => f());
    };
  }, []);

  /** Run an action on the models `ids`; a failure shows on their rows only. */
  const run = useCallback(
    async (action: () => Promise<ipc.MusicModel | void>, ids: string[]) => {
      setFailure(null);
      try {
        const next = await action();
        if (next) setModels(next);
      } catch (e) {
        setFailure({ text: errorText(e), ids });
      }
    },
    [],
  );

  return {
    models,
    errorFor: (id: string) => musicErrorFor(models, failure, id),
    error: musicGeneralError(models, failure),
    run,
  };
}

export const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Download progress over all models of the download in progress, 0–100. */
export function downloadPercent(models: ipc.MusicModel | null): number {
  if (!models?.totalBytes) return 0;
  return Math.round((models.doneBytes / models.totalBytes) * 100);
}
