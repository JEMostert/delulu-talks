//! The music step: YuE2 in the native `delulu-music` helper process, and the model
//! file it reads. The helper runs on this computer's graphics card (Vulkan) and
//! exits after each song, so its memory is free between songs. While you dictate it
//! is paused; going off air stops it.
use crate::model::Draft;
use crate::RadioError;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// YuE2 3B in ComfyUI's INT8 ConvRot packaging (Comfy-Org/YuE2 at a fixed revision).
pub const MODEL_FILE: &str = "yue2_3b_int8_convrot.safetensors";
pub const MODEL_URL: &str = "https://huggingface.co/Comfy-Org/YuE2/resolve/2f76ca75e6ee094169de899cc7fc99d6887e2196/checkpoints/yue2_3b_int8_convrot.safetensors";
pub const MODEL_SHA256: &str = "96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6";
pub const MODEL_BYTES: u64 = 3_960_938_800;
pub const MODEL_LABEL: &str = "YuE2 3B";
pub const MODEL_LICENSE: &str = "CC BY-NC 4.0";
const HELPER_NAME: &str = "delulu-music";
/// A song that takes longer than this (not counting pauses) is given up.
const DEADLINE: Duration = Duration::from_secs(40 * 60);

/// The helper: `DELULU_MUSIC_HELPER`, next to the app, or the system install.
pub fn helper_path() -> Option<PathBuf> {
    let from_env = std::env::var_os("DELULU_MUSIC_HELPER").map(PathBuf::from);
    let next_to_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(HELPER_NAME)));
    let system = Some(Path::new("/usr/lib/delulu-talks").join(HELPER_NAME));
    [from_env, next_to_exe, system]
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
}

/// What the helper is given for one song.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub style: String,
    pub lyrics: String,
    pub seed: u64,
    pub max_seconds: f32,
}

impl Song {
    pub fn new(draft: &Draft, seed: u64, max_seconds: u32) -> Song {
        Song {
            style: draft.style.clone(),
            lyrics: crate::writer::conditioning_lyrics(draft),
            seed,
            max_seconds: max_seconds as f32,
        }
    }
}

/// What a song's item records about its music, from the helper's report.
pub fn provenance(report: &Value) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("music".into(), format!("{MODEL_LABEL} (native)"));
    if let Some(device) = report["device"].as_str() {
        p.insert("device".into(), device.into());
    }
    let secs = |k: &str| report[k].as_f64().unwrap_or(0.0) / 1000.0;
    let total = ["loadMs", "scoreMs", "musicMs", "shapingMs", "renderMs"]
        .iter()
        .map(|k| secs(k))
        .sum::<f64>();
    p.insert("musicSeconds".into(), format!("{total:.1}"));
    if let Some(bytes) = report["peakGpuBytes"].as_u64() {
        p.insert("gpuMegabytes".into(), (bytes / 1_000_000).to_string());
    }
    p
}

/// Where a song is, for display.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    /// score, composing, shaping, rendering or loading
    pub phase: String,
    /// Overall 0..1.
    pub fraction: f32,
}

/// Map a helper progress event to an overall fraction. The phases take roughly
/// these shares of the time on a mid-range card.
fn stage(event: &Value, last: f32) -> Stage {
    let num = |k: &str| event[k].as_f64().unwrap_or(0.0) as f32;
    let (phase, fraction) = match event["phase"].as_str().unwrap_or_default() {
        "score" => ("score", 0.12 * (num("tokens") / 1500.0).min(1.0)),
        "music" => (
            "composing",
            0.12 + 0.40 * num("seconds") / num("maxSeconds").max(1.0),
        ),
        "shaping" => ("shaping", 0.52 + 0.43 * num("step") / num("steps").max(1.0)),
        "rendering" => (
            "rendering",
            0.95 + 0.05 * num("tile") / num("tiles").max(1.0),
        ),
        _ => ("loading", last),
    };
    Stage {
        phase: phase.into(),
        fraction: fraction.max(last).min(1.0),
    }
}

#[derive(Default)]
struct Running {
    pid: Option<u32>,
    paused: bool,
    stopped: bool,
}

/// Runs one song at a time and can stop or pause it from another thread.
#[derive(Default, Clone)]
pub struct Composer {
    running: Arc<Mutex<Running>>,
}

fn signal(pid: u32, sig: libc::c_int) {
    unsafe {
        libc::kill(pid as libc::pid_t, sig);
    }
}

impl Composer {
    fn lock(&self) -> std::sync::MutexGuard<'_, Running> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stop the song being made, if any. It counts as cancelled, not failed.
    pub fn stop(&self) {
        let mut r = self.lock();
        if let Some(pid) = r.pid {
            r.stopped = true;
            signal(pid, libc::SIGKILL);
        }
    }

    /// Freeze the helper while dictation needs the graphics card, and continue after.
    pub fn pause(&self, on: bool) {
        let mut r = self.lock();
        if r.paused != on {
            r.paused = on;
            if let Some(pid) = r.pid {
                signal(pid, if on { libc::SIGSTOP } else { libc::SIGCONT });
            }
        }
    }

    pub fn busy(&self) -> bool {
        self.lock().pid.is_some()
    }

    /// Make one song into `out` (48 kHz WAV). Returns the helper's report.
    pub fn compose(
        &self,
        helper: &Path,
        model: &Path,
        song: &Song,
        out: &Path,
        progress: &mut dyn FnMut(Stage),
    ) -> Result<Value, RadioError> {
        let mut child = Command::new(helper)
            .arg("generate")
            .arg("--model")
            .arg(model)
            .arg("--out")
            .arg(out)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                RadioError::Unavailable(format!("The music engine could not start: {e}"))
            })?;
        {
            let mut r = self.lock();
            r.pid = Some(child.id());
            r.stopped = false;
            if r.paused {
                signal(child.id(), libc::SIGSTOP);
            }
        }
        let json = serde_json::to_vec(song).expect("song json");
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&json);
        }
        // Keep the end of stderr for the log if the helper fails without a message.
        let mut stderr = child.stderr.take();
        let tail = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(err) = stderr.as_mut() {
                let _ = err.read_to_string(&mut text);
            }
            let start = text.len().saturating_sub(2000);
            text[text.ceil_char_boundary(start)..].to_string()
        });
        let done = Arc::new(AtomicBool::new(false));
        let watchdog = {
            let (done, me) = (done.clone(), self.clone());
            std::thread::spawn(move || {
                let mut active = Duration::ZERO;
                while !done.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(500));
                    if !me.lock().paused {
                        active += Duration::from_millis(500);
                    }
                    if active > DEADLINE {
                        me.stop();
                        return true;
                    }
                }
                false
            })
        };
        let mut outcome: Option<Result<Value, String>> = None;
        let mut last = 0.0f32;
        let started = Instant::now();
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(p) = value.get("progress") {
                    let s = stage(p, last);
                    last = s.fraction;
                    progress(s);
                } else if let Some(report) = value.get("done") {
                    outcome = Some(Ok(report.clone()));
                } else if let Some(e) = value.get("error").and_then(Value::as_str) {
                    outcome = Some(Err(e.to_string()));
                }
            }
        }
        let status = child.wait();
        done.store(true, Ordering::SeqCst);
        let timed_out = watchdog.join().unwrap_or(false);
        let stopped = {
            let mut r = self.lock();
            r.pid = None;
            std::mem::take(&mut r.stopped)
        };
        let stderr = tail.join().unwrap_or_default();
        if timed_out {
            return Err(RadioError::Music(
                "YuE2 took too long and was stopped".into(),
            ));
        }
        if stopped {
            return Err(RadioError::Cancelled);
        }
        match outcome {
            Some(Ok(report)) if status.as_ref().is_ok_and(|s| s.success()) => {
                log::info!(
                    "radio: song made in {:.0} s",
                    started.elapsed().as_secs_f64()
                );
                Ok(report)
            }
            Some(Err(message)) => Err(classify(message)),
            _ => {
                log::warn!("radio: music engine failed ({status:?}): {stderr}");
                Err(RadioError::Music(format!(
                    "The music engine stopped unexpectedly ({})",
                    status.map_or_else(|e| e.to_string(), |s| s.to_string())
                )))
            }
        }
    }
}

/// Out-of-memory and missing-device errors wait for the card to be free again
/// instead of counting as a failed song.
fn classify(message: String) -> RadioError {
    let lower = message.to_lowercase();
    if lower.contains("memory") || lower.contains("out of") {
        RadioError::Unavailable(format!(
            "Not enough graphics memory for the music model right now ({message})"
        ))
    } else {
        RadioError::Music(format!("YuE2: {message}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_only_move_forward() {
        let s = stage(
            &serde_json::json!({"phase": "music", "seconds": 60.0, "maxSeconds": 120.0}),
            0.0,
        );
        assert_eq!(s.phase, "composing");
        assert!((s.fraction - 0.32).abs() < 1e-6);
        let back = stage(
            &serde_json::json!({"phase": "loading", "model": "acoustic"}),
            s.fraction,
        );
        assert_eq!(back.fraction, s.fraction);
        let end = stage(
            &serde_json::json!({"phase": "rendering", "tile": 4, "tiles": 4}),
            0.9,
        );
        assert_eq!(end.fraction, 1.0);
    }

    /// A stand-in helper: a shell script speaking the same JSON lines.
    fn fake_helper(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("delulu-music");
        std::fs::write(&path, format!("#!/bin/sh\ncat > /dev/null\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn song() -> Song {
        Song {
            style: "pop".into(),
            lyrics: "[Verse]\nla".into(),
            seed: 1,
            max_seconds: 30.0,
        }
    }

    #[test]
    fn reports_progress_then_the_result() {
        let dir = std::env::temp_dir().join(format!("radio-music-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let helper = fake_helper(
            &dir,
            r#"printf '%s\n' '{"progress":{"phase":"shaping","step":16,"steps":32}}' '{"done":{"seconds":30}}'"#,
        );
        let mut stages = Vec::new();
        let report = Composer::default()
            .compose(&helper, &dir, &song(), &dir.join("o.wav"), &mut |s| {
                stages.push(s)
            })
            .unwrap();
        assert_eq!(report["seconds"], 30);
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].phase, "shaping");
        let failing = fake_helper(
            &dir,
            r#"printf '%s\n' '{"error":"out of memory for a compute graph"}'; exit 1"#,
        );
        let err = Composer::default()
            .compose(&failing, &dir, &song(), &dir.join("o.wav"), &mut |_| {})
            .unwrap_err();
        assert!(matches!(err, RadioError::Unavailable(_)), "{err:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stop_cancels_a_running_song() {
        let dir = std::env::temp_dir().join(format!("radio-music-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let helper = fake_helper(&dir, "exec sleep 30");
        let composer = Composer::default();
        let other = composer.clone();
        let stopper = std::thread::spawn(move || {
            while !other.busy() {
                std::thread::sleep(Duration::from_millis(10));
            }
            other.pause(true);
            other.pause(false);
            other.stop();
        });
        let started = Instant::now();
        let err = composer
            .compose(&helper, &dir, &song(), &dir.join("o.wav"), &mut |_| {})
            .unwrap_err();
        stopper.join().unwrap();
        assert!(matches!(err, RadioError::Cancelled), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
