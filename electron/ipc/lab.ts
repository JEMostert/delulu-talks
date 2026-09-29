import { dialog } from "electron";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { LabRequest } from "../../src/types";
import { validateText } from "./validation";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerLabIpc(
  { handle }: IpcRegistrar,
  {
    dictation,
    getMainWindow,
  }: Pick<
    IpcDependencies,
    | "dictation"
    | "getMainWindow"
  >,
): void {
  const selectedAudioFiles = new Set<string>();
  handle("lab:chooseAudio", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Choose audio or video",
      properties: ["openFile"],
      filters: [
        {
          name: "Audio and video",
          extensions: [
            "wav",
            "mp3",
            "m4a",
            "flac",
            "ogg",
            "opus",
            "webm",
            "mp4",
            "mov",
            "mkv",
          ],
        },
      ],
    };
    const mainWindow = getMainWindow();
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const path = result.canceled ? undefined : result.filePaths[0];
    if (!path) return null;
    const resolved = resolve(path);
    selectedAudioFiles.add(resolved);
    return {
      path: resolved,
      name: basename(resolved),
      size: statSync(resolved).size,
    };
  });
  handle("lab:run", async (_event, request: LabRequest) => {
    const path = resolve(validateText(request.path, 4096));
    if (!selectedAudioFiles.has(path) || !existsSync(path))
      throw new Error("Choose the source file through Audio files first");
    return dictation.runLab({ path });
  });
}
