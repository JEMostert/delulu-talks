import {
  Activity,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { LoaderCircle } from "lucide-react";
import { bridge } from "../bridge";
import type { useTalk } from "../hooks/useTalk";
import type { useVoice } from "../hooks/useVoice";
import { createTranscriptCommands } from "../transcriptCommands";
import type { Page, ShownPage } from "../types";
import { workspaceCommands, type Workspace } from "./workspace";

/** Lazy-load a named page export, keeping its prop types. */
const named = <M extends Record<K, ComponentType<any>>, K extends string>(
  load: () => Promise<M>,
  name: K,
) => lazy(() => load().then((module) => ({ default: module[name] })));

const HistoryPage = named(() => import("../pages/HistoryPage"), "HistoryPage");
const VocabularyPage = named(
  () => import("../pages/VocabularyPage"),
  "VocabularyPage",
);
const VoicePage = named(() => import("../pages/VoicePage"), "VoicePage");
const SettingsPage = named(
  () => import("../pages/SettingsPage"),
  "SettingsPage",
);

/** A page mounts on first visit and then stays alive, hidden, to keep its state. */
function View({
  page,
  current,
  visited,
  children,
}: {
  page: ShownPage;
  current: ShownPage;
  visited: Set<ShownPage>;
  children: ReactNode;
}) {
  if (current !== page && !visited.has(page)) return null;
  return (
    <Activity name={page} mode={current === page ? "visible" : "hidden"}>
      <div className="workspace-view">{children}</div>
    </Activity>
  );
}

export function PageViews({
  workspace: w,
  voice,
  talk,
  busy,
  onNavigate,
  onClose,
}: {
  workspace: Workspace;
  voice: ReturnType<typeof useVoice>;
  talk: ReturnType<typeof useTalk>;
  busy: boolean;
  onNavigate: (page: Page) => void;
  onClose: () => void;
}) {
  const [visited, setVisited] = useState<Set<ShownPage>>(
    () => new Set([w.page]),
  );
  useEffect(() => {
    setVisited((previous) =>
      previous.has(w.page) ? previous : new Set([...previous, w.page]),
    );
  }, [w.page]);
  const c = workspaceCommands(w);
  const { actions, onClearHistory } = createTranscriptCommands(w);
  const transcriptActions = {
    ...actions,
    onCancelRewrite: (operationId: string) => bridge.cancelRewrite(operationId),
    onOpenRewrite: (record: Parameters<typeof w.operations.openRewrite>[0]) =>
      w.operations.openRewrite(record, w.page),
  };
  const view = { current: w.page, visited };
  return (
    <Suspense
      fallback={
        <div className="panel-loading" role="status" aria-label="Opening panel">
          <LoaderCircle className="spin" />
        </div>
      }
    >
      <View page="history" {...view}>
        <HistoryPage
          historyLimit={w.settings.historyLimit}
          keepHistory={w.settings.keepHistory}
          onOpenSettings={() => {
            w.setSettingsSection("privacy");
            onNavigate("settings");
          }}
          busy={busy}
          history={w.history}
          view={w.historyView}
          onViewChange={w.setHistoryView}
          {...transcriptActions}
          onClear={onClearHistory}
          onExportSelection={w.exportSelection}
          onDeleteSelection={w.deleteSelection}
          deletionPending={w.historyDeletion?.phase === "pending"}
        />
      </View>
      <View page="vocabulary" {...view}>
        <VocabularyPage
          words={w.settings.customWords}
          packs={w.settings.wordPacks}
          hintsActive={
            w.settings.vocabularyHints &&
            w.settings.speechEngine === "large" &&
            w.capabilities?.platform !== "darwin"
          }
          saving={w.saving}
          onChange={(customWords) =>
            w.saveSettings({ customWords }, "Words saved")
          }
          onPacksChange={(wordPacks) =>
            w.saveSettings({ wordPacks }, "Word packs saved")
          }
        />
      </View>
      <View page="voice" {...view}>
        <VoicePage
          settings={w.settings}
          voice={voice}
          talk={talk}
          devices={w.devices}
          speechReady={!["missing", "error"].includes(w.status.engine)}
          onSetupSpeech={() => onNavigate("models")}
          saving={w.saving}
          onSave={w.saveSettings}
          onAction={w.action}
          onCopy={w.copy}
        />
      </View>
      <View page="settings" {...view}>
        <SettingsPage
          section={w.settingsSection}
          onSectionChange={w.setSettingsSection}
          onDone={w.settings.onboardingComplete ? undefined : onClose}
          onCancelSetup={c.cancelSetup}
          onCancelSetupMagic={c.cancelSetupMagic}
          settings={w.settings}
          devices={w.devices}
          capabilities={w.capabilities}
          shortcutStatus={w.shortcutStatus}
          updateStatus={w.updateStatus}
          status={w.status}
          magicStatus={w.magicStatus}
          saving={w.saving}
          onSave={w.saveSettings}
          onConfigureShortcut={c.run(() => bridge.configureShortcut())}
          onAuthorizePaste={c.run(
            () => bridge.authorizePaste(),
            "Paste permission saved",
          )}
          onTestCaptureCue={c.run(() => bridge.testCaptureCue())}
          onTestPaste={() => {
            w.setToast("Focus another text field — pasting in 3 seconds…");
            void w.action(
              () => bridge.testPaste(),
              "Paste test shortcut sent — check your destination",
            );
          }}
          onCheckForUpdates={c.run(() => bridge.checkForUpdates())}
          onDownloadUpdate={c.download}
          onInstallUpdate={c.install}
          onSetup={c.setup}
          onLoad={c.load}
          onUnload={c.unload}
          onSetupMagic={c.setupMagic}
          onLoadMagic={c.loadMagic}
          onUnloadMagic={c.unloadMagic}
          onReset={c.run(
            () => bridge.resetPythonEnvironment(),
            "Runtime removed",
          )}
        />
      </View>
    </Suspense>
  );
}
