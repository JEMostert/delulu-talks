import type { PasteLastService } from "../services/pasteLast";
import type { PasteRecovery } from "../../src/types";
import type { ModelCacheService } from "../services/modelCache";
import type { RuleUsageService } from "../services/ruleUsage";
import type { SerialQueue } from "../runtime/serialQueue";
import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from "electron";
import type { AppSettings, TranscriptRecord } from "../../src/types";
import type { AsrService } from "../services/asr";
import type { DictationService } from "../services/dictation";
import type { PasteService } from "../services/paste";
import type { PillService } from "../services/pill";
import type { ShortcutService } from "../services/shortcut";
import type { StorageService } from "../services/storage";
import type { UpdateService } from "../services/updates";

export interface IpcRegistrar {
  handle<Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown,
  ): void;
  on<Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: Args) => void,
  ): void;
}

export interface IpcDependencies {
  getMainWindow: () => BrowserWindow | null;
  storage: StorageService;
  asr: AsrService;
  paste: PasteService;
  pill: PillService;
  dictation: DictationService;
  shortcut: ShortcutService;
  updates: UpdateService;
  persistSettings: (value: unknown) => Promise<AppSettings>;
  settingsBusy: () => boolean;
  getLastTranscript: () => TranscriptRecord | null;
  setLastTranscript: (record: TranscriptRecord | null) => void;
  sessionTranscripts: Map<string, TranscriptRecord>;
  rebuildTrayMenu: () => void;
  pasteLast: PasteLastService;
  modelCache: ModelCacheService;
  ruleUsage: RuleUsageService;
  schedulePasteLast: () => unknown;
  getPasteRecovery: () => PasteRecovery | null;
  setPasteRecovery: (recovery: PasteRecovery | null) => void;
  applySettings: (value: unknown) => Promise<AppSettings>;
  settingsQueue: SerialQueue;
  broadcast: (channel: string, payload: unknown) => void;
  selectedAudioFiles: Set<string>;
}
