import { registerSelectedTextIpc } from "./selectedText";
import { registerProjectVocabularyIpc } from "./projectVocabulary";
import { registerDictationIpc } from "./dictation";
import { registerHistoryIpc } from "./history";
import { registerLabIpc } from "./lab";
import { registerPasteIpc } from "./paste";
import { createIpcRegistrar } from "./registrar";
import { registerRendererIpc } from "./renderer";
import { registerRuntimeIpc } from "./runtime";
import { registerSettingsIpc } from "./settings";
import type { IpcDependencies } from "./types";
import { registerUpdatesIpc } from "./updates";

export function registerMainIpc(dependencies: IpcDependencies) {
  const registrar = createIpcRegistrar(dependencies.getMainWindow);
  registerRendererIpc(registrar, dependencies);
  registerSettingsIpc(registrar, dependencies);
  registerRuntimeIpc(registrar, dependencies);
  registerDictationIpc(registrar, dependencies);
  registerPasteIpc(registrar, dependencies);
  registerUpdatesIpc(registrar, dependencies);
  registerHistoryIpc(registrar, dependencies);
  const lab = registerLabIpc(registrar, dependencies);
  registerProjectVocabularyIpc(registrar, dependencies);
  registerSelectedTextIpc(registrar, dependencies);
  return lab;
}
