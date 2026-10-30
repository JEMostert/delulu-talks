//! Music through the listener's own ComfyUI, driven by the installed Comfy CLI.
//! Delulu never starts, stops, frees or downloads into ComfyUI, and it only waits
//! for, cancels or collects prompts it submitted itself.
use crate::model::Draft;
use crate::RadioError;
use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const CHECKPOINT: &str = "yue2_3b_int8_convrot.safetensors";
pub const CHECKPOINT_URL: &str =
    "https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_int8_convrot.safetensors";
/// The official YuE2 Text to Music template's API graph (ComfyUI workflow_templates,
/// audio_yue2_text2music): full ABC planning, 32-step dpm_2 / sgm_uniform decoding.
const WORKFLOW: &str = include_str!("../assets/yue2.json");
const NODES: [&str; 3] = ["YuE2GenerateABC", "YuE2GenerateMusic", "SaveAudioAdvanced"];

/// The command that installs the checkpoint into the user's ComfyUI.
pub fn install_command() -> String {
    format!(
        "comfy model download --url {CHECKPOINT_URL} --relative-path models/checkpoints --filename {CHECKPOINT}"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Waiting,
    Done,
    Failed(String),
    /// The server has no record (restarted or history pruned).
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyReadiness {
    pub cli: bool,
    pub server: bool,
    pub nodes: bool,
    pub checkpoint: bool,
    pub url: String,
}

impl ComfyReadiness {
    pub fn ready(&self) -> bool {
        self.cli && self.server && self.nodes && self.checkpoint
    }
}

#[derive(Debug, Clone)]
pub struct Comfy {
    pub bin: PathBuf,
    pub url: String,
}

/// Comfy CLI error codes that prove no prompt was accepted.
const NOT_SUBMITTED: &[&str] = &[
    "usage_error",
    "prompt_rejected",
    "client_error",
    "workflow_not_found",
    "workflow_invalid_json",
    "workflow_not_api_format",
    "workflow_read_error",
    "workflow_empty",
    "workflow_unknown_nodes",
    "conversion_error",
    "partner_node_requires_credential",
    "partner_node_requires_consent",
    "object_info_unavailable",
    "server_unreachable",
    "connection_refused",
    "server_not_running",
];

impl Default for Comfy {
    fn default() -> Self {
        Comfy::from_env()
    }
}

impl Comfy {
    /// `DELULU_COMFY_BIN` and `DELULU_COMFY_URL` override `comfy` on PATH and the
    /// default local server.
    pub fn from_env() -> Comfy {
        let bin = std::env::var_os("DELULU_COMFY_BIN")
            .map(PathBuf::from)
            .or_else(|| find_on_path("comfy"))
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|h| PathBuf::from(h).join(".local/bin/comfy"))
                    .filter(|p| p.is_file())
            })
            .unwrap_or_else(|| PathBuf::from("comfy"));
        let url = std::env::var("DELULU_COMFY_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8188".into())
            .trim_end_matches('/')
            .to_string();
        Comfy { bin, url }
    }

    fn host_port(&self) -> (String, String) {
        let rest = self
            .url
            .split_once("://")
            .map(|(_, r)| r)
            .unwrap_or(&self.url);
        let authority = rest.split('/').next().unwrap_or(rest);
        match authority.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), port.to_string()),
            None => (authority.to_string(), "8188".into()),
        }
    }

    fn target(&self) -> Vec<String> {
        let (host, port) = self.host_port();
        vec!["--host".into(), host, "--port".into(), port]
    }

    /// Run `comfy --json --where local …` and return the final envelope's data.
    fn cli(&self, args: &[String], timeout: Duration) -> Result<Value, CliError> {
        let mut command = Command::new(&self.bin);
        command
            .args(["--json", "--where", "local"])
            .args(args)
            .env("COMFY_NO_WATCH", "1")
            .env("COMFY_WHERE", "local")
            .env("COMFY_LOCAL_URL", &self.url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (status, stdout, stderr) = run(command, timeout)?;
        let envelope = stdout
            .lines()
            .rev()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|v| v.get("type").and_then(Value::as_str) == Some("envelope"))
            .or_else(|| serde_json::from_str::<Value>(&stdout).ok())
            .unwrap_or(Value::Null);
        if status && envelope.get("ok") == Some(&Value::Bool(true)) {
            return Ok(envelope.get("data").cloned().unwrap_or(Value::Null));
        }
        let error = envelope.get("error").cloned().unwrap_or(Value::Null);
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("failed")
            .to_string();
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| tail(&stderr));
        Err(CliError::Failed {
            code,
            message,
            details: error.get("details").cloned().unwrap_or(Value::Null),
        })
    }

    /// Cheap checks: no model loads and no generation.
    pub fn readiness(&self) -> ComfyReadiness {
        let mut ready = ComfyReadiness {
            url: self.url.clone(),
            ..Default::default()
        };
        ready.cli = Command::new(&self.bin)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(4)))
            .build()
            .into();
        let get = |path: &str| -> Option<Value> {
            let mut response = agent.get(&format!("{}{path}", self.url)).call().ok()?;
            let body = response.body_mut().read_to_string().ok()?;
            serde_json::from_str(&body).ok()
        };
        ready.server = get("/system_stats").is_some();
        if !ready.server {
            return ready;
        }
        ready.nodes = NODES
            .iter()
            .all(|n| get(&format!("/object_info/{n}")).is_some_and(|v| v.get(*n).is_some()));
        ready.checkpoint = get("/object_info/CheckpointLoaderSimple").is_some_and(|v| {
            v.pointer("/CheckpointLoaderSimple/input/required/ckpt_name/0")
                .and_then(Value::as_array)
                .is_some_and(|names| names.iter().any(|n| n.as_str() == Some(CHECKPOINT)))
        });
        ready
    }

    /// Write the API workflow for one song.
    pub fn write_workflow(
        &self,
        path: &Path,
        draft: &Draft,
        seed: u64,
        max_seconds: u32,
        prefix: &str,
    ) -> Result<(), RadioError> {
        let workflow = workflow(draft, seed, max_seconds, prefix);
        std::fs::write(path, serde_json::to_vec_pretty(&workflow).expect("json"))
            .map_err(|e| RadioError::Io(format!("{}: {e}", path.display())))
    }

    /// Submit without waiting. `Err(NotSubmitted)` proves nothing reached the
    /// server; any other error leaves the outcome uncertain.
    pub fn submit(&self, workflow: &Path) -> Result<String, SubmitError> {
        let mut args = vec![
            "run".into(),
            "--workflow".into(),
            workflow.display().to_string(),
            "--no-watch".into(),
            "--no-notify".into(),
            "--timeout".into(),
            "20".into(),
        ];
        args.extend(self.target());
        match self.cli(&args, Duration::from_secs(45)) {
            Ok(data) => data
                .get("prompt_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| SubmitError::Uncertain("Comfy returned no prompt id".into())),
            Err(CliError::Failed { code, message, .. })
                if NOT_SUBMITTED.contains(&code.as_str()) =>
            {
                Err(SubmitError::NotSubmitted(format!("ComfyUI: {message}")))
            }
            Err(CliError::Spawn(message)) => Err(SubmitError::NotSubmitted(message)),
            Err(e) => Err(SubmitError::Uncertain(e.to_string())),
        }
    }

    /// The prompt id of an earlier submit of `workflow` whose outcome was unknown:
    /// the Comfy CLI's record first, then ComfyUI's own queue and history, matched by
    /// the job's unique output `prefix` across all retained history. `Ok(None)` only when
    /// the server answered and holds no such prompt; anything uncertain is an error.
    pub fn find_submitted(
        &self,
        workflow: &Path,
        prefix: &str,
    ) -> Result<Option<String>, RadioError> {
        let mut args = vec![
            "jobs".into(),
            "ls".into(),
            "--local-only".into(),
            "--limit".into(),
            "500".into(),
        ];
        args.extend(self.target());
        let wanted = workflow.display().to_string();
        if let Ok(data) = self.cli(&args, Duration::from_secs(30)) {
            let recorded = data
                .get("jobs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|j| j.get("workflow_path").and_then(Value::as_str) == Some(wanted.as_str()))
                .and_then(|j| j.get("prompt_id").and_then(Value::as_str))
                .map(str::to_string);
            if recorded.is_some() {
                return Ok(recorded);
            }
        }
        let unavailable = |what: &str| {
            RadioError::Unavailable(format!(
                "ComfyUI did not answer ({what}); waiting before deciding whether the song was submitted"
            ))
        };
        let queue = self.get("/queue").ok_or_else(|| unavailable("queue"))?;
        let history = self.get("/history").ok_or_else(|| unavailable("history"))?;
        Ok(find_prompt(&queue, &history, prefix))
    }

    fn get(&self, path: &str) -> Option<Value> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .build()
            .into();
        let mut response = agent.get(&format!("{}{path}", self.url)).call().ok()?;
        let body = response
            .body_mut()
            .with_config()
            .limit(256 << 20)
            .read_to_string()
            .ok()?;
        serde_json::from_str(&body).ok()
    }

    pub fn status(&self, prompt_id: &str) -> Result<JobState, RadioError> {
        let mut args = vec!["jobs".into(), "status".into(), prompt_id.into()];
        args.extend(self.target());
        match self.cli(&args, Duration::from_secs(30)) {
            Ok(data) => Ok(job_state(&data)),
            Err(CliError::Failed { code, details, .. })
                if code == "prompt_not_found"
                    && details.get("server_confirmed_no_record") == Some(&Value::Bool(true)) =>
            {
                Ok(JobState::Unknown)
            }
            Err(CliError::Failed { code, .. }) if code == "server_not_running" => {
                Err(RadioError::Unavailable(
                    "ComfyUI is not running. The song in progress continues once it is back."
                        .into(),
                ))
            }
            Err(e) => Err(RadioError::Unavailable(format!("ComfyUI: {e}"))),
        }
    }

    /// Cancel one of our own prompts (only used past the deadline).
    pub fn cancel(&self, prompt_id: &str) {
        let mut args = vec!["jobs".into(), "cancel".into(), prompt_id.into()];
        args.extend(self.target());
        if let Err(e) = self.cli(&args, Duration::from_secs(30)) {
            log::warn!("radio: cancel {prompt_id}: {e}");
        }
    }

    /// Download the prompt's outputs into `dir`; returns audio files only.
    pub fn download(&self, prompt_id: &str, dir: &Path) -> Result<Vec<PathBuf>, RadioError> {
        std::fs::create_dir_all(dir).map_err(|e| RadioError::Io(e.to_string()))?;
        let args = vec![
            "download".into(),
            prompt_id.into(),
            "--out-dir".into(),
            dir.display().to_string(),
        ];
        let data = self
            .cli(&args, Duration::from_secs(120))
            .map_err(|e| RadioError::Music(format!("download: {e}")))?;
        let root = dir
            .canonicalize()
            .map_err(|e| RadioError::Io(e.to_string()))?;
        let mut files: Vec<PathBuf> = data
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|f| f.get("path").and_then(Value::as_str))
            .filter_map(|p| Path::new(p).canonicalize().ok())
            .filter(|p| p.starts_with(&root) && p.is_file())
            .filter(|p| {
                matches!(
                    p.extension()
                        .and_then(|e| e.to_str())
                        .map(str::to_ascii_lowercase)
                        .as_deref(),
                    Some("flac" | "wav")
                )
            })
            .collect();
        files.sort();
        Ok(files)
    }
}

/// A queued, running or finished prompt whose graph saves under `prefix`. Queue entries
/// and history prompts are `[number, prompt_id, graph, …]`.
fn find_prompt(queue: &Value, history: &Value, prefix: &str) -> Option<String> {
    let saves_here = |graph: &Value| {
        graph.as_object().is_some_and(|nodes| {
            nodes.values().any(|n| {
                n.pointer("/inputs/filename_prefix").and_then(Value::as_str) == Some(prefix)
            })
        })
    };
    let entry_id = |entry: &Value| {
        let graph = entry.get(2)?;
        saves_here(graph)
            .then(|| entry.get(1).and_then(Value::as_str).map(str::to_string))
            .flatten()
    };
    ["queue_running", "queue_pending"]
        .iter()
        .filter_map(|k| queue.get(*k).and_then(Value::as_array))
        .flatten()
        .find_map(entry_id)
        .or_else(|| {
            history
                .as_object()?
                .values()
                .find_map(|h| h.get("prompt").and_then(entry_id))
        })
}

fn job_state(data: &Value) -> JobState {
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match status {
        "completed" | "success" => JobState::Done,
        "error" | "failed" | "cancelled" | "interrupted" => JobState::Failed(
            data.get("error_message")
                .and_then(Value::as_str)
                .unwrap_or(status)
                .to_string(),
        ),
        "unknown" => JobState::Unknown,
        _ => JobState::Waiting,
    }
}

/// Fill the template's named inputs for one song.
pub fn workflow(draft: &Draft, seed: u64, max_seconds: u32, prefix: &str) -> Value {
    let mut graph: Value = serde_json::from_str(WORKFLOW).expect("bundled workflow");
    let lyrics = if draft.instrumental {
        "[Instrumental]".to_string()
    } else {
        draft.lyrics.clone().unwrap_or_default()
    };
    let set = |graph: &mut Value, node: &str, input: &str, value: Value| {
        graph[node]["inputs"][input] = value;
    };
    set(&mut graph, "1", "filename_prefix", prefix.into());
    set(&mut graph, "2", "ckpt_name", CHECKPOINT.into());
    set(&mut graph, "7", "max_duration", max_seconds.into());
    // JSON numbers stay exact below 2^53.
    set(&mut graph, "14", "seed", (seed % (1 << 50)).into());
    set(&mut graph, "15", "value", draft.style.clone().into());
    set(&mut graph, "16", "value", lyrics.into());
    graph
}

#[derive(Debug, thiserror::Error)]
pub enum SubmitError {
    #[error("{0}")]
    NotSubmitted(String),
    #[error("{0}")]
    Uncertain(String),
}

#[derive(Debug, thiserror::Error)]
enum CliError {
    #[error("{0}")]
    Spawn(String),
    #[error("Comfy CLI timed out")]
    Timeout,
    #[error("{message} ({code})")]
    Failed {
        code: String,
        message: String,
        details: Value,
    },
}

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().rev().take(4).collect();
    lines
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

/// Run to completion or kill at `timeout`. Returns success, stdout and stderr.
fn run(mut command: Command, timeout: Duration) -> Result<(bool, String, String), CliError> {
    let mut child = command
        .spawn()
        .map_err(|e| CliError::Spawn(format!("Comfy CLI is not available: {e}")))?;
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let out_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CliError::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(CliError::Spawn(e.to_string())),
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    Ok((status.success(), stdout, stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(instrumental: bool) -> Draft {
        Draft {
            title: "T".into(),
            subtitle: "S".into(),
            style: "Warm pop".into(),
            lyrics: Some("[Verse]\nla".into()),
            script: None,
            instrumental,
        }
    }

    #[test]
    fn workflow_fills_named_inputs() {
        let w = workflow(&draft(false), u64::MAX, 180, "delulu-radio/job-1/song");
        assert_eq!(
            w["1"]["inputs"]["filename_prefix"],
            "delulu-radio/job-1/song"
        );
        assert_eq!(w["2"]["inputs"]["ckpt_name"], CHECKPOINT);
        assert_eq!(w["7"]["inputs"]["max_duration"], 180);
        assert!(w["14"]["inputs"]["seed"].as_u64().unwrap() < 1 << 50);
        assert_eq!(w["15"]["inputs"]["value"], "Warm pop");
        assert_eq!(w["16"]["inputs"]["value"], "[Verse]\nla");
        assert_eq!(w["1"]["class_type"], "SaveAudioAdvanced");
        assert_eq!(
            workflow(&draft(true), 1, 90, "p")["16"]["inputs"]["value"],
            "[Instrumental]"
        );
    }

    #[test]
    fn states_map_from_cli() {
        let v = |s: &str| serde_json::json!({ "status": s });
        assert_eq!(job_state(&v("completed")), JobState::Done);
        assert_eq!(job_state(&v("running")), JobState::Waiting);
        assert_eq!(job_state(&v("queued")), JobState::Waiting);
        assert_eq!(job_state(&v("unknown")), JobState::Unknown);
        assert!(matches!(job_state(&v("error")), JobState::Failed(_)));
    }

    #[test]
    fn finds_an_accepted_prompt_by_its_prefix() {
        let graph = |p: &str| serde_json::json!({ "1": { "inputs": { "filename_prefix": p } } });
        let queue = serde_json::json!({
            "queue_running": [[1, "other", graph("x/song")]],
            "queue_pending": [[2, "mine", graph("delulu-radio/song-a/song")]],
        });
        let empty = serde_json::json!({});
        assert_eq!(
            find_prompt(&queue, &empty, "delulu-radio/song-a/song").as_deref(),
            Some("mine")
        );
        let history = serde_json::json!({ "done": { "prompt": [3, "done", graph("delulu-radio/song-b/song")] } });
        assert_eq!(
            find_prompt(&empty, &history, "delulu-radio/song-b/song").as_deref(),
            Some("done")
        );
        assert_eq!(
            find_prompt(&queue, &history, "delulu-radio/song-c/song"),
            None
        );
    }

    #[test]
    fn host_and_port_come_from_url() {
        let c = Comfy {
            bin: "comfy".into(),
            url: "http://localhost:9000".into(),
        };
        assert_eq!(c.host_port(), ("localhost".into(), "9000".into()));
    }

    #[test]
    fn missing_cli_is_not_a_submission() {
        let c = Comfy {
            bin: "/nonexistent/comfy".into(),
            url: "http://127.0.0.1:1".into(),
        };
        assert!(matches!(
            c.submit(Path::new("/tmp/x.json")),
            Err(SubmitError::NotSubmitted(_))
        ));
        assert!(!c.readiness().cli);
    }
}
