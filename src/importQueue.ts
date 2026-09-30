export type ImportJobState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type ImportQueueJob = {
  id: string;
  path: string;
  name: string;
  size: number;
  state: ImportJobState;
  error: string | null;
  transcriptId: string | null;
};
export type ImportQueueSnapshot = {
  version: number;
  paused: boolean;
  jobs: ImportQueueJob[];
};
export const IMPORT_QUEUE_LIMIT = 20;
export function emptyImportQueue(): ImportQueueSnapshot {
  return { version: 0, paused: true, jobs: [] };
}
