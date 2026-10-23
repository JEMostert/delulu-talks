import { useEffect, useState } from "react";
import { Bot, Copy, Plug, Puzzle } from "lucide-react";
import { Alert, SettingRow, Tabs, Toggle } from "../ui";
import type { VoiceSkillInstall } from "../../listening";
import type { VoiceAgentSetup, VoiceBridgeStatus } from "../../voice";

const SNIPPETS = [
  ["claudeCode", "Claude Code"],
  ["codex", "Codex"],
  ["json", "MCP JSON"],
  ["shell", "Command line"],
] as const;
type Snippet = (typeof SNIPPETS)[number][0];

const HINTS: Record<Snippet, string> = {
  claudeCode: "Run once in a terminal. Adds the speak tool for every project.",
  codex: "Run once in a terminal. Adds the speak tool to Codex.",
  json: "For any other MCP client: add this to its server list.",
  shell: "Agents without MCP can run this command to speak.",
};

/** Let local coding agents speak and hear you, and copy what each one needs to connect. */
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
  const state = !enabled
    ? "Off"
    : bridge.error
      ? "Needs attention"
      : bridge.listening
        ? bridge.clients === 1
          ? "Listening · 1 agent connected"
          : `Listening · ${bridge.clients} agents connected`
        : "Starting…";
  return (
    <>
      <section className="pref-group">
        <h3>a · Turn it on</h3>
        <div className="pref-list">
          <SettingRow
            icon={Bot}
            title="Let coding agents speak"
            description="Your lead agent briefs you out loud when it's done, stuck or needs a decision."
            help="Agents on this computer connect through a local socket that only your user account can open, with a token Delulu creates for you. Nothing leaves this device."
          >
            <Toggle
              value={enabled}
              label="Let coding agents speak"
              disabled={saving}
              onChange={onToggle}
            />
          </SettingRow>
          {enabled && (
            <SettingRow icon={Plug} title="Connection" description={state}>
              {bridge.endpoint && (
                <code className="voice-endpoint" title={bridge.endpoint}>
                  {bridge.endpoint}
                </code>
              )}
            </SettingRow>
          )}
        </div>
        {enabled && bridge.error && (
          <div className="mt-2">
            <Alert>{bridge.error}</Alert>
          </div>
        )}
      </section>
      {enabled && (
        <section className="pref-group">
          <h3>b · Add Delulu to your agent</h3>
          <div className="pref-list voice-connect">
            {error ? (
              <div className="p-4">
                <Alert tone="info">{error}</Alert>
              </div>
            ) : !setup ? (
              <p className="caption p-4">Preparing the connection details…</p>
            ) : (
              <>
                <Tabs
                  className="voice-snippet-tabs"
                  label="Agent"
                  tabs={SNIPPETS}
                  value={snippet}
                  onChange={setSnippet}
                />
                <div className="voice-snippet">
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
                </div>
                <p className="caption voice-snippet-note">
                  These commands run the Delulu Talks app itself with mcp, so no
                  extra runtime is needed.
                </p>
                <p className="caption voice-snippet-note">
                  T3 Code uses the Claude Code or Codex configuration of the
                  provider it runs, so add it there.
                </p>
              </>
            )}
          </div>
        </section>
      )}
      {enabled && setup && (
        <section className="pref-group">
          <h3>c · Tell your lead agent when to speak</h3>
          <div className="pref-list voice-connect">
            <div className="voice-snippet">
              <p className="caption">
                Add these to your lead agent's instructions (CLAUDE.md or
                AGENTS.md) so it briefs you like a colleague.
              </p>
              <pre className="voice-instructions">
                <code>{setup.instructions}</code>
              </pre>
              <button
                className="secondary-button"
                onClick={() => onCopy(setup.instructions)}
              >
                <Copy /> Copy instructions
              </button>
            </div>
          </div>
        </section>
      )}
      {enabled && (
        <section className="pref-group">
          <h3>d · Let your agent hear you</h3>
          <div className="pref-list">
            <SettingRow
              icon={Puzzle}
              title="Agent skill"
              description="Teaches Claude Code to pick up what you say in Talk."
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
                Install skill for Claude Code
              </button>
            </SettingRow>
          </div>
          {installed && (
            <p className="pref-note">Installed to {installed.join(", ")}</p>
          )}
        </section>
      )}
    </>
  );
}
