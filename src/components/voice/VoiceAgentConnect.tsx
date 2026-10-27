import { useEffect, useState } from "react";
import { Bot, Copy, Info, Puzzle, Users } from "lucide-react";
import { Alert, SettingRow, Tabs } from "../ui";
import type { VoiceSkillInstall } from "../../listening";
import { agentsLine, type DotTone, type TalkAgent } from "../../talk";
import type { VoiceAgentSetup, VoiceBridgeStatus } from "../../voice";

const SNIPPETS = [
  ["claudeCode", "Claude Code"],
  ["codex", "Codex"],
  ["json", "MCP JSON"],
  ["shell", "Command line"],
  ["instructions", "Instructions"],
] as const;
type Snippet = (typeof SNIPPETS)[number][0];

const HINTS: Record<Snippet, string> = {
  claudeCode: "Run once in a terminal.",
  codex: "Run once in a terminal.",
  json: "Add to your MCP client's server list.",
  shell: "For agents without MCP.",
  instructions: "Paste into your lead agent's CLAUDE.md or AGENTS.md.",
};

/** The agent connection in a few words. */
export function bridgeLine(bridge: VoiceBridgeStatus): string {
  if (bridge.error) return "Needs attention";
  if (!bridge.listening) return "Starting…";
  if (bridge.clients === 0) return "Waiting for an agent";
  return bridge.clients === 1
    ? "1 agent connected"
    : `${bridge.clients} agents connected`;
}

/** How local coding agents reach Siren and Sonar, and what each one needs. */
export function VoiceAgentConnect({
  sirenOn,
  enabled,
  bridge,
  agents,
  saving,
  load,
  installSkill,
  onEnable,
  onCopy,
  onAction,
}: {
  /** Siren is on; agents only connect while it is. */
  sirenOn: boolean;
  /** The saved agent connection; older settings may have it off. */
  enabled: boolean;
  bridge: VoiceBridgeStatus;
  /** Agents taking tasks from Sonar. */
  agents: readonly TalkAgent[];
  saving: boolean;
  load: () => Promise<VoiceAgentSetup>;
  installSkill: () => Promise<VoiceSkillInstall>;
  onEnable: () => void;
  onCopy: (text: string) => void;
  onAction: (run: () => Promise<unknown>, success?: string) => Promise<boolean>;
}) {
  const [setup, setSetup] = useState<VoiceAgentSetup | null>(null);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<Snippet>("claudeCode");
  // Open for someone connecting their first agent.
  const [showSetup, setShowSetup] = useState(
    sirenOn && enabled && bridge.clients === 0,
  );
  useEffect(() => {
    let alive = true;
    load()
      .then((value) => {
        if (!alive) return;
        setSetup(value);
        setError(null);
      })
      .catch((reason) => {
        if (alive)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      alive = false;
    };
    // The script is installed when the bridge starts; read it again then.
  }, [enabled, bridge.listening]);

  const connected = sirenOn && enabled;
  let tone: DotTone = "";
  let line = "Turn on Siren to let agents connect";
  if (sirenOn && !enabled) {
    tone = "warning";
    line = "Agent connection is off";
  } else if (connected) {
    tone = bridge.error ? "error" : bridge.listening ? "ready" : "busy";
    line = bridgeLine(bridge);
  }

  return (
    <section className="pref-list" aria-label="Connect your agents">
      <div className="setting-row">
        <Bot className="setting-icon" aria-hidden="true" />
        <div className="setting-copy">
          <strong>Connect your agents</strong>
          <details className="setting-help">
            <summary
              aria-label="About connecting agents"
              title="About connecting agents"
            >
              <Info />
            </summary>
            <p>
              Agents on this computer connect through a local socket only your
              user account can open, with a token Delulu creates for you.
              Nothing leaves this device.
            </p>
          </details>
          <p className="siren-state" role="status" aria-live="polite">
            <span className={`status-dot ${tone}`} aria-hidden="true" />
            {line}
          </p>
        </div>
        <div className="setting-control">
          {sirenOn && !enabled && (
            <button
              className="secondary-button"
              disabled={saving}
              onClick={onEnable}
            >
              Turn on
            </button>
          )}
        </div>
      </div>
      {connected && bridge.error && (
        <div className="siren-block">
          <Alert>{bridge.error}</Alert>
        </div>
      )}
      {connected && agents.length > 0 && (
        <SettingRow
          icon={Users}
          title="Agents"
          description={agentsLine(agents)}
        >
          {null}
        </SettingRow>
      )}
      <details
        className="siren-setup"
        open={showSetup}
        onToggle={(event) => setShowSetup(event.currentTarget.open)}
      >
        <summary>Setup instructions</summary>
        <div className="siren-snippet">
          {error ? (
            <Alert tone="info">{error}</Alert>
          ) : !setup ? (
            <p className="caption">Preparing the setup…</p>
          ) : (
            <>
              <Tabs
                label="Agent"
                tabs={SNIPPETS}
                value={snippet}
                onChange={setSnippet}
              />
              <p className="caption">{HINTS[snippet]}</p>
              <pre>
                <code>{setup[snippet]}</code>
              </pre>
              <button
                className="secondary-button"
                onClick={() => onCopy(setup[snippet])}
              >
                <Copy /> Copy
              </button>
            </>
          )}
        </div>
      </details>
      <SettingRow
        icon={Puzzle}
        title="Agent skill"
        description={
          installed
            ? `Installed to ${installed.join(", ")}`
            : "Lets Claude Code and Codex take tasks from Sonar"
        }
      >
        <button
          className="secondary-button"
          onClick={() =>
            void onAction(async () => {
              const result = await installSkill();
              setInstalled(result.paths);
            }, "Skill installed")
          }
        >
          {installed ? "Reinstall" : "Install"}
        </button>
      </SettingRow>
    </section>
  );
}
