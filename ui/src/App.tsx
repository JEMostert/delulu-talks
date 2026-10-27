import { useAppState, type Page } from "./state";
import { FirstRun } from "./screens/FirstRun";
import { Home } from "./screens/Home";
import { History } from "./screens/History";
import { Settings } from "./screens/Settings";
import "./style.css";

export default function App() {
  const state = useAppState();
  const { status, settings, notice, setNotice, page, setPage, setQuery } =
    state;
  if (!status || !settings)
    return (
      <main className="loading">
        <img src="/delulu-talks-icon.svg" alt="" />
        <p>{notice || "Starting Delulu Talks…"}</p>
      </main>
    );
  if (status.phase === "needsSetup") return <FirstRun state={state} />;
  return (
    <div className="app">
      <aside>
        <div className="brand">
          <img src="/delulu-talks-icon.svg" alt="" />
          <span>Delulu Talks</span>
        </div>
        <nav aria-label="Main navigation">
          {(["Home", "History", "Settings"] as Page[]).map((item) => (
            <button
              key={item}
              className={page === item ? "selected" : ""}
              onClick={() => {
                setPage(item);
                setQuery("");
              }}
            >
              {item}
            </button>
          ))}
        </nav>
        <p className="aside-note">Your voice, on your machine.</p>
      </aside>
      <main className="content">
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button aria-label="Dismiss message" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {page === "Home" && <Home state={state} />}
        {page === "History" && <History state={state} />}
        {page === "Settings" && <Settings state={state} />}
      </main>
    </div>
  );
}
