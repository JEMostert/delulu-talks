import { useEffect, useState } from "react";
import { Bot, Copy, Puzzle } from "lucide-react";
import { Alert, SettingRow, Tabs, Toggle } from "../ui";
import type { VoiceSkillInstall } from "../../listening";
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

/** The agent connection in a few words, for the row and the summary. */
export function bridgeLine(bridge: VoiceBridgeStatus): string {
  if (bridge.error) return "Needs attention";
  if (!bridge.listening) return "Starting…";
  if (bridge.clients === 0) return "Waiting for an agent";
  return bridge.clients === 1
    ? "1 agent connected"
    : `${bridge.clients} agents connected`;
}

/** Let local coding agents speak and hear you, and copy what each one needs. */
export function VoiceAgentConnect({
  enabled,
  bridge,
  saving,
  load,
  installSkill,
  onToggle,
  onCopy,
  onAction,
}: {
  enabled: boolean;
  bridge: VoiceBridgeStatus;
  saving: boolean;
  load: () => Promise<VoiceAgentSetup>;
  installSkill: () => Promise<VoiceSkillInstall>;
  onToggle: () => void;
  onCopy: (text: string) => void;
  onAction: (run: () => Promise<unknown>, success?: string) => Promise<boolean>;
}) {
  const [setup, setSetup] = useState<VoiceAgentSetup | null>(null);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<Snippet>("claudeCode");
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
  return (
    <div className="pref-list">
      <SettingRow
        icon={Bot}
        title="Let coding agents speak"
        description={enabled ? bridgeLine(bridge) : undefined}
        help="Agents on this computer connect through a local socket only your user account can open, with a token Delulu creates for you. Nothing leaves this device."
      >
        <Toggle
          value={enabled}
          label="Let coding agents speak"
          disabled={saving}
          onChange={onToggle}
        />
      </SettingRow>
      {enabled && bridge.error && (
        <div className="siren-block">
          <Alert>{bridge.error}</Alert>
        </div>
      )}
      {enabled && (
        <div className="siren-block siren-snippet">
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
      )}
      {enabled && (
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
      )}
    </div>
  );
}
