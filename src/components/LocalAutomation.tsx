import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { AUTOMATION_CAPABILITIES, type AutomationCapability, type AutomationStatus, type WatchedImport } from "../localAutomation";

export function LocalAutomation() {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("Editor");
  const [capabilities, setCapabilities] = useState<AutomationCapability[]>(["events:status"]);
  const [directories, setDirectories] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [watches, setWatches] = useState<WatchedImport[]>([]);
  const [watchDirectory, setWatchDirectory] = useState("");
  const [autoRun, setAutoRun] = useState(false);
  useEffect(() => { let live = true; void bridge.getAutomationStatus().then((value) => { if (live) setStatus(value); }).catch((reason) => { if (live) setError(String(reason)); }); return () => { live = false; }; }, []);
  useEffect(() => { let live = true; void bridge.getWatchedImports().then((value) => { if (live) setWatches(value); }).catch((reason) => { if (live) setError(String(reason)); }); return () => { live = false; }; }, []);
  const run = async (action: () => Promise<void>) => {
    setError(null); setBusy(true);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="panel content-stack" aria-label="Local automation">
    <div><h3>Local automation</h3><p className="caption">Connect your CLI and editor to the running desktop app. Requests stay on this machine. Each integration has a separate token and explicit permissions.</p></div>
    {error && <p role="alert">{error}</p>}
    {status?.error && <p role="alert">Automation permissions were preserved; API activation is blocked: {status.error}</p>}
    <button className="secondary-button" disabled={busy || !status?.available} onClick={() => void run(async () => { setStatus(await bridge.setAutomationEnabled(!status?.enabled)); })}>{status?.enabled ? "Disable loopback API" : "Enable loopback API"}</button>
    {status?.enabled && <div className="content-stack"><code>{status.url}</code><p className="caption">Owner CLI connection file: {status.connectionFile}. Treat its token as private. Disabling the API closes subscriptions; restart rotates the owner token.</p></div>}
    {status?.available && <form className="content-stack" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      const grant = await bridge.grantAutomation({ name, capabilities, directories: directories.split(/\r?\n/).map((path) => path.trim()).filter(Boolean) });
      setToken(grant.token); setStatus(await bridge.getAutomationStatus());
    }); }}>
      <label>Integration name<input value={name} maxLength={128} onChange={(event) => setName(event.target.value)} /></label>
      <fieldset><legend>Granted capabilities</legend>{AUTOMATION_CAPABILITIES.map((capability) => <label key={capability} className="flex items-center gap-2"><input type="checkbox" checked={capabilities.includes(capability)} onChange={() => setCapabilities((current) => current.includes(capability) ? current.filter((entry) => entry !== capability) : [...current, capability])} />{capability}</label>)}</fieldset>
      {capabilities.includes("audio:transcribe") && <label>Allowed audio directories, one absolute path per line<textarea value={directories} onChange={(event) => setDirectories(event.target.value)} rows={3} /></label>}
      <button className="secondary-button" disabled={busy || !name.trim() || !capabilities.length}>Create scoped token</button>
    </form>}
    {token && <div className="content-stack"><p>Save this token now. It is shown once and stored as a hash.</p><code className="break-all select-all">{token}</code><button className="secondary-button" onClick={() => setToken(null)}>Hide token</button></div>}
    {status?.integrations.map((integration) => <div key={integration.id} className="content-stack"><strong>{integration.name}</strong><p className="caption">{integration.capabilities.join(" · ")}</p>{integration.directories.length > 0 && <p className="caption">Audio roots: {integration.directories.join(" · ")}</p>}<button className="secondary-button" disabled={busy} onClick={() => void run(async () => { setStatus(await bridge.revokeAutomation(integration.id)); setToken(null); })}>Revoke {integration.name}</button></div>)}
    <div><h3>Watched audio folders</h3><p className="caption">Explicit folders only, with no recursion or symlink following. Stable files enter the same durable Audio files queue; matching audio bytes are imported once per watch. Failed jobs remain available to retry.</p></div>
    <form className="content-stack" onSubmit={(event) => { event.preventDefault(); void run(async () => { setWatches(await bridge.addWatchedImport(watchDirectory, autoRun)); setWatchDirectory(""); }); }}>
      <label>Absolute import directory<input value={watchDirectory} onChange={(event) => setWatchDirectory(event.target.value)} /></label>
      <label><input type="checkbox" checked={autoRun} onChange={(event) => setAutoRun(event.target.checked)} />Start the shared queue automatically when new audio arrives</label>
      <button className="secondary-button" disabled={busy || !status?.available || !watchDirectory.trim()}>Watch folder</button>
    </form>
    {watches.map((watch) => <div key={watch.id} className="content-stack"><code>{watch.directory}</code><p className="caption">{watch.imported} queued audio fingerprints · {watch.autoRun ? "Auto-run enabled" : "Queue manually"}</p>{watch.error && <p role="alert">{watch.error}</p>}<div className="flex gap-2"><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { setWatches(await bridge.setWatchedImportEnabled(watch.id, !watch.enabled)); })}>{watch.enabled ? "Pause watch" : "Resume watch"}</button><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { setWatches(await bridge.removeWatchedImport(watch.id)); })}>Remove watch</button></div></div>)}
  </section>;
}
