//! Agent setup: the copyable MCP registration commands, the agent skill and
//! the legacy Node script (`voiceAgentSetup`, `installVoiceSkill` and
//! `installVoiceAgentScript` in `voiceBridge.ts` / `main.ts`).
//!
//! Agents now run the app executable itself with the `mcp` subcommand, so no
//! Node runtime (or `ELECTRON_RUN_AS_NODE`) is needed.

use std::path::{Path, PathBuf};

use delulu_core::util::stage_private;
use delulu_core::{AppPaths, DomainResult};
use delulu_domain::listening::VoiceSkillInstall;
use delulu_domain::voice::{VoiceAgentSetup, VOICE_AGENT_INSTRUCTIONS};

/// The Node MCP script Electron releases copied beside `bridge.json`.
pub const VOICE_AGENT_SCRIPT: &str = "delulu-voice-mcp.mjs";
/// The subcommand that runs the MCP server and CLI ([`crate::run_cli`]).
pub const MCP_SUBCOMMAND: &str = "mcp";

/// The executable agents should run. An AppImage mounts at a new path on
/// every launch; its file path (`$APPIMAGE`) is stable.
pub fn agent_executable() -> PathBuf {
    match std::env::var_os("APPIMAGE") {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => std::env::current_exe().unwrap_or_else(|_| PathBuf::from("delulu-talks")),
    }
}

fn is_plain(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '/' | '.' | ':' | '=' | '@' | '%' | '+' | ',' | '-'))
}

fn quote(value: &str, windows: bool) -> String {
    if is_plain(value) {
        value.to_owned()
    } else if windows {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn words(values: &[String], windows: bool) -> String {
    values.iter().map(|value| quote(value, windows)).collect::<Vec<_>>().join(" ")
}

/// Copyable commands that register the MCP server with common agents.
/// `windows` selects PowerShell quoting.
pub fn voice_agent_setup(executable: &Path, windows: bool) -> VoiceAgentSetup {
    let executable = executable.to_string_lossy().into_owned();
    let command = vec![executable.clone(), MCP_SUBCOMMAND.to_owned()];
    let example = "Done, all tests pass.".to_owned();
    let mut say = command.clone();
    say.extend(["say".to_owned(), example]);
    let shell = if windows { format!("& {}", words(&say, true)) } else { words(&say, false) };
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": { "delulu-voice": { "command": command[0], "args": command[1..] } }
    }))
    .unwrap_or_default();
    VoiceAgentSetup {
        script_path: executable,
        claude_code: format!("claude mcp add --scope user delulu-voice -- {}", words(&command, windows)),
        codex: format!("codex mcp add delulu-voice -- {}", words(&command, windows)),
        command,
        node_found: false,
        json,
        shell,
        instructions: VOICE_AGENT_INSTRUCTIONS.to_owned(),
    }
}

/// Install the delulu-voice skill for Claude Code and Codex, with this
/// machine's command in place of `{{SCRIPT}}`.
pub fn install_voice_skill(paths: &AppPaths, setup: &VoiceAgentSetup) -> DomainResult<VoiceSkillInstall> {
    let template = std::fs::read_to_string(paths.resource("voice/skill/SKILL.md"))?;
    let skill = template.replace("{{SCRIPT}}", &words(&setup.command, false));
    let mut installed = Vec::new();
    for root in [".claude", ".codex"] {
        let path = paths.home.join(root).join("skills").join("delulu-voice").join("SKILL.md");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, &skill)?;
        installed.push(path.to_string_lossy().into_owned());
    }
    Ok(VoiceSkillInstall { paths: installed })
}

/// Copy `source` to `directory/delulu-voice-mcp.mjs`; unchanged content is
/// not rewritten. Returns the target path.
pub fn install_voice_agent_script(directory: &Path, source: &Path) -> std::io::Result<PathBuf> {
    let target = directory.join(VOICE_AGENT_SCRIPT);
    let contents = std::fs::read(source)?;
    if std::fs::read(&target).is_ok_and(|existing| existing == contents) {
        return Ok(target);
    }
    crate::service::create_private_dir(directory)?;
    let temporary = stage_private(&target, &contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))?;
    }
    delulu_core::util::publish(&temporary, &target)?;
    Ok(target)
}

/// Agents registered by Electron releases run the Node script beside
/// `bridge.json`; the protocol is unchanged, so keep an existing copy current
/// instead of breaking them. Nothing is installed when there is no copy.
pub fn refresh_legacy_agent_script(paths: &AppPaths) {
    let directory = paths.voice_dir();
    let source = paths.resource("voice/delulu-voice-mcp.mjs");
    if directory.join(VOICE_AGENT_SCRIPT).exists() && source.exists() {
        if let Err(error) = install_voice_agent_script(&directory, &source) {
            log::warn!("could not refresh the legacy voice agent script: {error}");
        }
    }
}
