import { useCallback } from "react";
import { useAppState, type Page } from "./state";
import { useScheme } from "./useScheme";
import { Header, Wordmark } from "./components/Header";
import { Toast } from "./components/Toast";
import { Pearl } from "./pearl/Pearl";
import { FirstRun } from "./screens/FirstRun";
import { Home } from "./screens/Home";
import { History } from "./screens/History";
import { Cleanup } from "./screens/Cleanup";
import { Radio } from "./screens/Radio";
import { Settings } from "./screens/Settings";
import "./styles/index.css";

export default function App() {
  const state = useAppState();
  const { status, settings, notice, setNotice, page, setPage, setQuery } =
    state;
  useScheme(settings?.theme);
  const dismiss = useCallback(() => setNotice(""), [setNotice]);
  const navigate = useCallback(
    (next: Page) => {
      setPage(next);
      setQuery("");
    },
    [setPage, setQuery],
  );
  if (!status || !settings)
    return (
      <main className="launch">
        <Wordmark />
        <Pearl mode="loadingModel" label="Starting" className="launch-pearl" />
        <p role="status">{notice || "Starting Delulu Talks…"}</p>
      </main>
    );
  if (status.phase === "needsSetup") return <FirstRun state={state} />;
  // Turning LLM FM off in Settings hides its page.
  const shown: Page = page === "LLM FM" && !settings.radio ? "Settings" : page;
  return (
    <div className="app">
      <Header
        page={shown}
        phase={status.phase}
        radio={settings.radio}
        onNavigate={navigate}
      />
      <main
        className={`page page-${shown.toLowerCase().replace(" ", "-")}`}
        key={shown}
      >
        {shown === "Home" && <Home state={state} />}
        {shown === "History" && <History state={state} />}
        {shown === "Cleanup" && <Cleanup state={state} />}
        {shown === "LLM FM" && <Radio state={state} />}
        {shown === "Settings" && <Settings state={state} />}
      </main>
      <Toast notice={notice} onDismiss={dismiss} />
    </div>
  );
}
