import { useSyncExternalStore } from "react";
import { checkUpdate, installUpdate } from "../ipc";
import { errorText } from "../state";
import { Line } from "./Controls";

type UpdateStatus = {
  action: "check" | "install" | "busy" | "installed";
  message: string;
};

// Settings unmounts during navigation. Keep the operation and its outcome
// visible when the user returns, including after a successful installation.
let status: UpdateStatus = { action: "check", message: "" };
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function show(action: UpdateStatus["action"], message: string) {
  status = { action, message };
  for (const listener of listeners) listener();
}
async function run() {
  const action = status.action;
  try {
    if (action === "check") {
      show("busy", "Checking for updates…");
      const version = await checkUpdate();
      if (version) show("install", `Version ${version} is available.`);
      else show("check", "You have the latest release.");
    } else if (action === "install") {
      show("busy", "Downloading update…");
      await installUpdate((message) => show("busy", message));
      show(
        "installed",
        "Installed. Quit Delulu Talks from the tray and reopen it.",
      );
    }
  } catch (error) {
    show(
      "check",
      `${action === "install" ? "Installation failed" : "Could not check for updates"}. ${errorText(error)}`,
    );
  }
}

export function AppUpdates() {
  const { action, message } = useSyncExternalStore(subscribe, () => status);
  return (
    <>
      <Line label="App updates">
        {(action === "check" || action === "install") && (
          <button
            className="button quiet small"
            type="button"
            onClick={() => void run()}
          >
            {action === "install" ? "Install update" : "Check for updates"}
          </button>
        )}
      </Line>
      <div className="app-update-status" role="status">
        {message}
      </div>
    </>
  );
}
