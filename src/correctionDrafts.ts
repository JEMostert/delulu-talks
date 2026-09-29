import { useCallback, useSyncExternalStore } from "react";

type CorrectionDraft = {
  text: string;
  savedText: string;
  error: string | null;
};

// Renderer-session only. Page changes do not discard work; no draft is written
// to disk or automatically retried. Successful save/delete and explicit discard
// release the text immediately.
const drafts = new Map<string, CorrectionDraft>();
const listeners = new Map<string, Set<() => void>>();
const notify = (id: string) =>
  listeners.get(id)?.forEach((listener) => listener());

export function writeCorrectionDraft(id: string, text: string, savedText: string) {
  const previous = drafts.get(id);
  drafts.set(id, {
    text,
    savedText: previous?.savedText ?? savedText,
    error: previous?.error ?? null,
  });
  notify(id);
}

export function failCorrectionDraft(id: string, error: string) {
  const previous = drafts.get(id);
  if (!previous) return;
  drafts.set(id, { ...previous, error });
  notify(id);
}

export function discardCorrectionDraft(id: string) {
  drafts.delete(id);
  notify(id);
}

export function clearCorrectionDrafts() {
  const ids = [...drafts.keys()];
  drafts.clear();
  ids.forEach(notify);
}

export function useCorrectionDraft(id: string) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(id) ?? new Set<() => void>();
      listeners.set(id, group);
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(id);
      };
    },
    [id],
  );
  const snapshot = useCallback(() => drafts.get(id), [id]);
  return useSyncExternalStore(subscribe, snapshot, () => undefined);
}
