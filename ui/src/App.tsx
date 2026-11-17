import { useCallback } from "react";
import { useAppState, type Page } from "./state";
import { useScheme } from "./useScheme";
import { Rail, Wordmark } from "./components/Rail";
import { Toast } from "./components/Toast";
import { TooltipLayer } from "./components/Tooltip";
import { Pearl } from "./pearl/Pearl";
import { FirstRun } from "./screens/FirstRun";
import { Dictate } from "./screens/Dictate";
import { Cleanup } from "./screens/Cleanup";
import { Radio } from "./screens/Radio";
import { Settings, VoicePage } from "./screens/Settings";
import { Models } from "./screens/Models";
import "./styles/index.css";

export default function App() {
  const state = useAppState();
  const { status, settings, notice, setNotice, page, navigate } = state;
  useScheme(settings?.theme);
  const dismiss = useCallback(() => setNotice(""), [setNotice]);
  if (!status || !settings)
    return (
      <main className="launch">
        <Wordmark />
        <Pearl mode="loadingModel" label="Starting" className="launch-pearl" />
        <p role="status">{notice || "Starting Delulu Talks…"}</p>
      </main>
    );
  if (status.phase === "needsSetup")
    return (
      <>
        <FirstRun state={state} />
        <TooltipLayer />
      </>
    );
  // Turning Delulu FM off in Settings hides its page.
  const shown: Page =
    page === "Delulu FM" && !settings.radio ? "Settings" : page;
  return (
    <div className="app">
      <Rail
        page={shown}
        status={status}
        radioShown={settings.radio}
        radio={state.radio}
        onNavigate={navigate}
      />
      <main
        className={`page page-${shown.toLowerCase().replace(" ", "-")}`}
        key={shown}
      >
        {shown === "Dictate" && <Dictate state={state} />}
        {shown === "Vocabulary" && <Cleanup state={state} />}
        {shown === "Delulu FM" && <Radio state={state} />}
        {shown === "Voice" && <VoicePage state={state} />}
        {shown === "Models" && <Models state={state} />}
        {shown === "Settings" && <Settings state={state} />}
      </main>
      <Toast notice={notice} onDismiss={dismiss} />
      <TooltipLayer />
    </div>
  );
}
