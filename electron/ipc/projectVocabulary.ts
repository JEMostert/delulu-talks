import { dialog } from "electron";
import { ProjectVocabularyScope } from "../services/projectVocabularyScope";
import type { IpcDependencies, IpcRegistrar } from "./types";

export function registerProjectVocabularyIpc({handle}: IpcRegistrar, {getMainWindow}: Pick<IpcDependencies,"getMainWindow">): void {
  const projectVocabulary = new ProjectVocabularyScope();
  handle("projectVocabulary:choose", (_event,input:unknown) => projectVocabulary.choose(input));
  handle("projectVocabulary:get", () => projectVocabulary.get());
  handle("projectVocabulary:refresh", () => projectVocabulary.refresh());
  handle("projectVocabulary:clear", () => projectVocabulary.clear());
  handle("projectVocabulary:select", async () => {
    const options: Electron.OpenDialogOptions = {title:"Select a repository for project vocabulary",properties:["openDirectory"]};
    const window = getMainWindow();
    const result = window ? await dialog.showOpenDialog(window,options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? projectVocabulary.get() : projectVocabulary.select(result.filePaths[0]);
  });
}
