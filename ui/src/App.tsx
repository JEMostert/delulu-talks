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
  return (
    <div className="app">
      <Header page={page} phase={status.phase} onNavigate={navigate} />
      <main className={`page page-${page.toLowerCase()}`} key={page}>
        {page === "Home" && <Home state={state} />}
        {page === "History" && <History state={state} />}
        {page === "Cleanup" && <Cleanup state={state} />}
        {page === "Settings" && <Settings state={state} />}
      </main>
      <Toast notice={notice} onDismiss={dismiss} />
    </div>
  );
}
