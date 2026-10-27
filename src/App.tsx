import brandMark from "./assets/delulu-talks-mark.svg";
import { bridge } from "./bridge";
import { LatestResult } from "./components/LatestResult";
import { OceanBackground } from "./components/OceanBackground";
import { OceanController } from "./components/OceanController";
import { QuickSettings } from "./components/QuickSettings";
import { TalkIndicator } from "./components/voice/TalkIndicator";
import { useTalk } from "./hooks/useTalk";
import { useTheme } from "./hooks/useTheme";
import { useVoice } from "./hooks/useVoice";
import { Dock } from "./shell/Dock";
import { EngineChip } from "./shell/EngineChip";
import { pageTitle } from "./shell/navigation";
import { Notices } from "./shell/Notices";
import { PageViews } from "./shell/PageViews";
import { RewriteHost } from "./shell/RewriteHost";
import { SheetHeader } from "./shell/SheetHeader";
import { Toast } from "./shell/Toast";
import { usePanel } from "./shell/usePanel";
import { useWindowVisible } from "./shell/useWindowVisible";
import {
  homeCaption,
  isBusy,
  isRecording,
  type Workspace,
} from "./shell/workspace";
import { deliveredText } from "./transcriptText";

/** The ocean home with its pearl, and the sheet that rises over it for every page. */
function App({ workspace: w }: { workspace: Workspace }) {
  const theme = useTheme(w.settings.theme);
  const voice = useVoice();
  const talk = useTalk();
  const visible = useWindowVisible();
  const panel = usePanel(w);
  const busy = isBusy(w);
  const latest = w.history[0];
  const copyLatest = () =>
    latest
      ? w.action(() => bridge.copyText(deliveredText(latest)))
      : Promise.resolve(false);
  const title = panel.quick ? "Quick settings" : pageTitle(w.page);
  return (
    <main
      className={`ocean-app ${panel.open ? "panel-open" : ""}`}
      data-visible={visible}
    >
      <OceanBackground
        recording={w.status.phase === "listening"}
        theme={theme}
        covered={panel.open}
        visible={visible}
      />
      <div className="ocean-brand" aria-hidden="true">
        <img src={brandMark} alt="" />
        Delulu Talks
      </div>
      <TalkIndicator
        status={talk.status}
        onStop={() => void w.action(talk.stop)}
      />
      {w.ready && !panel.open && (
        <EngineChip status={w.status} onOpen={() => panel.navigate("models")} />
      )}
      <a
        className="ocean-skip"
        href={
          isRecording(w)
            ? "#recording-stop-control"
            : "#recording-start-control"
        }
      >
        Skip to dictation controls
      </a>
      <section
        ref={panel.ref}
        className={`workspace-sheet ${panel.quick ? "quick-sheet" : "wide-sheet"}`}
        data-open={panel.open}
        aria-label={panel.quick ? title : `${title} panel`}
        tabIndex={-1}
      >
        <SheetHeader
          title={title}
          status={w.status}
          magicStatus={w.magicStatus}
          closeLabel={
            !w.settings.onboardingComplete && w.page === "models"
              ? "Dismiss setup"
              : "Close panel"
          }
          hidden={!panel.open}
          onClose={panel.close}
        />
        <Notices
          workspace={w}
          busy={busy}
          panelOpen={panel.open}
          onNavigate={panel.navigate}
        />
        <div
          className="sheet-content page-scroll"
          hidden={!panel.open}
          id="page-content"
          tabIndex={-1}
          role="region"
          aria-label={panel.quick ? "Quick settings controls" : title}
        >
          {panel.quick && (
            <QuickSettings
              workspace={w}
              busy={busy}
              onNavigate={panel.navigate}
            />
          )}
          <PageViews
            workspace={w}
            voice={voice}
            talk={talk}
            busy={busy}
            onNavigate={panel.navigate}
            onClose={panel.close}
          />
        </div>
      </section>
      <OceanController
        navigation={
          panel.open ? (
            <Dock
              page={w.page}
              quickSheet={panel.quick}
              onNavigate={panel.navigate}
              onHome={panel.close}
            />
          ) : undefined
        }
        status={w.status}
        ready={w.ready}
        busy={busy}
        panelOpen={panel.open}
        canCopy={!!latest}
        resultId={latest?.id}
        message={homeCaption(w)}
        onRecord={() => w.action(() => bridge.toggleDictation())}
        onCopy={copyLatest}
        onSetup={() => panel.navigate("models")}
        onSettings={panel.toggleQuick}
        onPause={() =>
          w.action(() =>
            w.status.phase === "paused"
              ? bridge.resumeDictation()
              : bridge.pauseDictation(),
          )
        }
        onCancel={() => w.action(() => bridge.cancelDictation())}
      />
      {latest &&
        w.ready &&
        !panel.open &&
        !busy &&
        !w.status.captureInputNotice && (
          <LatestResult
            record={latest}
            onCopy={copyLatest}
            onOpen={() => panel.navigate("history")}
          />
        )}
      <RewriteHost workspace={w} onSetup={() => panel.navigate("models")} />
      <Toast message={w.toast} onDismiss={() => w.setToast(null)} />
    </main>
  );
}
export default App;
