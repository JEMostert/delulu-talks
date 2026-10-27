import type { InsertResult, Language, Settings } from "./ipc";
export const formatMs = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
export const formatDate = (timestamp: number) =>
  new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
export const languageName = (code: string, languages: Language[]) => {
  const name =
    languages.find((language) => language.code === code)?.name ?? code;
  return name.charAt(0).toUpperCase() + name.slice(1);
};
export const settingsPatch = <K extends keyof Settings>(
  settings: Settings,
  key: K,
  value: Settings[K],
): Settings => ({ ...settings, [key]: value });
export function insertMessage(result: InsertResult): string {
  switch (result.kind) {
    case "pasted":
      return "Inserted";
    case "copied":
      return "Copied — press Ctrl+V";
    case "failed":
      return `Could not insert or copy: ${result.reason}`;
    case "skipped":
      return "Nothing to insert";
  }
}
