//! Transcript cleanup: the helper process, its model download, and what a
//! dictation types given cleanup's answer. Every miss falls back to the raw Whisper
//! text; dictation never waits for cleanup.
//!
//! [`Supervisor`] owns the one cleanup helper (`delulu-engine llm`): it loads it
//! once Whisper has settled, restarts it once after a failure, downloads its model,
//! and lends it to one dictation (or Delulu FM's writer) at a time.
use delulu_cleanup::{Cleaner, CleanerKill};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Gemma 4 E4B, the text cleanup model.
pub static CLEANUP_MODEL: delulu_models::ModelFile = delulu_models::GEMMA_4_E4B.files[0];
/// The first Vulkan run compiles shaders.
const LOAD_TIMEOUT: Duration = Duration::from_secs(180);
/// How long a new helper waits for the previous one to be reaped.
const RETIRE_TIMEOUT: Duration = Duration::from_secs(30);
/// How often [`Supervisor::watch`] checks that the idle helper is still alive.
const WATCH_INTERVAL: Duration = Duration::from_millis(500);
/// A helper that dies this soon after it became ready counts as a failure, so a
/// helper that keeps crashing ends in "error" instead of restarting forever.
const QUICK_EXIT: Duration = Duration::from_secs(30);
const NO_HELPER: &str =
    "The cleanup engine (delulu-engine) is not installed; dictation uses the raw text.";
const GAVE_UP: &str =
    "Cleanup was too slow or failed; using raw text. Turn it off and on to retry.";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupStatus {
    pub state: &'static str,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
    pub backend: Option<String>,
}

/// A running helper. `_live` holds the one-helper slot until the process is reaped,
/// so it is declared after `cleaner` and dropped last.
pub(crate) struct Helper {
    cleaner: Cleaner,
    ready_at: Instant,
    _live: Live,
}
struct Live(Arc<AtomicUsize>);
impl Drop for Live {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone)]
pub(crate) struct Attempt {
    id: u64,
    cancel: Arc<AtomicBool>,
}

/// The previous helper, stopped outside the lock.
#[derive(Default)]
pub(crate) struct Retired {
    kill: Option<CleanerKill>,
    helper: Option<Helper>,
}
impl Retired {
    fn stop(self) {
        if let Some(kill) = self.kill {
            kill.kill();
        }
        drop(self.helper);
    }
}

/// Work to start after a state change, outside the lock.
#[derive(Default)]
pub(crate) struct Action {
    retired: Retired,
    /// Start a helper for this generation.
    load: Option<u64>,
    /// Start a download worker for this attempt.
    download: Option<Attempt>,
}

#[derive(Clone, Copy)]
/// What the settings and files ask of cleanup right now; the caller reads them.
pub struct Want {
    pub enabled: bool,
    pub first_run_done: bool,
    pub model_ok: bool,
    pub file_ready: bool,
}

pub(crate) struct Inner {
    status: CleanupStatus,
    /// The idle helper. A dictation takes it out while cleaning.
    helper: Option<Helper>,
    /// Kills the current helper whether it is loading, idle or borrowed.
    kill: Option<CleanerKill>,
    /// Bumped whenever the current helper is retired; stale results are dropped.
    generation: u64,
    loading: bool,
    /// Whisper has finished loading (or failed); only then may the helper load.
    whisper_settled: bool,
    failures: u32,
    /// A load error or a second clean failure; only off/on or `start_cleanup` retries.
    blocked: bool,
    /// The automatic download already ran this session.
    auto_tried: bool,
    attempt: Option<Attempt>,
    next_attempt: u64,
    /// A download worker thread is running (possibly a cancelled one, still exiting).
    worker: bool,
    /// The running worker should pick up `attempt` when it exits.
    pending: bool,
}

pub fn percent(done: u64, total: u64) -> u64 {
    (done.min(total) * 100).checked_div(total).unwrap_or(0)
}

impl Inner {
    fn new(enabled: bool, file_ready: bool) -> Self {
        Inner {
            status: CleanupStatus {
                state: match (enabled, file_ready) {
                    (false, _) => "off",
                    (true, true) => "loading",
                    (true, false) => "missing",
                },
                done_bytes: 0,
                total_bytes: CLEANUP_MODEL.bytes,
                error: None,
                backend: None,
            },
            helper: None,
            kill: None,
            generation: 0,
            loading: false,
            whisper_settled: false,
            failures: 0,
            blocked: false,
            auto_tried: false,
            attempt: None,
            next_attempt: 0,
            worker: false,
            pending: false,
        }
    }
    fn set(&mut self, state: &'static str, error: Option<String>) {
        self.status.state = state;
        self.status.error = error;
        self.status.done_bytes = 0;
        self.status.backend = None;
    }
    fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }
    fn retire(&mut self) -> Retired {
        self.generation += 1;
        self.loading = false;
        Retired {
            kill: self.kill.take(),
            helper: self.helper.take(),
        }
    }
    /// Replace any helper with a fresh one, once Whisper has settled.
    fn begin_load(&mut self) -> Action {
        let retired = self.retire();
        self.set("loading", None);
        self.loading = self.whisper_settled;
        Action {
            retired,
            load: self.loading.then_some(self.generation),
            download: None,
        }
    }
    fn off(&mut self) -> Action {
        self.cancel_download();
        self.failures = 0;
        self.blocked = false;
        self.auto_tried = false;
        let retired = self.retire();
        self.set("off", None);
        Action {
            retired,
            ..Default::default()
        }
    }
    fn sync(&mut self, want: Want) -> Action {
        if !want.enabled {
            return self.off();
        }
        if !want.file_ready {
            if self.attempt.is_some() {
                return Action::default();
            }
            if want.first_run_done && want.model_ok && !self.auto_tried {
                self.auto_tried = true;
                return self.start_download();
            }
            if self.status.state != "missing" {
                self.set("missing", None);
            }
            return Action::default();
        }
        if !want.first_run_done || self.blocked {
            return Action::default();
        }
        if self.helper.is_some() || self.loading || self.kill.is_some() {
            return Action::default();
        }
        self.begin_load()
    }
    /// `start_cleanup`: the Download / "Try again" button.
    fn start(&mut self, want: Want) -> Action {
        if !want.enabled {
            return Action::default();
        }
        self.failures = 0;
        self.blocked = false;
        if want.file_ready {
            self.begin_load()
        } else if self.attempt.is_some() {
            Action::default()
        } else {
            self.auto_tried = true;
            self.start_download()
        }
    }
    fn start_download(&mut self) -> Action {
        self.next_attempt += 1;
        let attempt = Attempt {
            id: self.next_attempt,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        self.attempt = Some(attempt.clone());
        self.set("downloading", None);
        if self.worker {
            // A cancelled worker is still exiting; it starts this attempt when it does.
            self.pending = true;
            return Action::default();
        }
        self.worker = true;
        Action {
            download: Some(attempt),
            ..Default::default()
        }
    }
    fn cancel_download(&mut self) -> bool {
        let Some(attempt) = self.attempt.take() else {
            return false;
        };
        attempt.cancel.store(true, Ordering::SeqCst);
        self.pending = false;
        true
    }
    fn is_attempt(&self, id: u64) -> bool {
        self.attempt.as_ref().is_some_and(|a| a.id == id)
    }
    /// Record progress; true when the whole percent changed and should be published.
    fn progress(&mut self, id: u64, done: u64, total: u64) -> bool {
        if !self.is_attempt(id)
            || percent(done, total) == percent(self.status.done_bytes, self.status.total_bytes)
        {
            return false;
        }
        self.status.done_bytes = done;
        self.status.total_bytes = total;
        true
    }
    /// A worker finished attempt `id`. The returned `download` hands the worker to a
    /// newer attempt that waited for it.
    fn download_done(&mut self, id: u64, result: Result<(), String>) -> Action {
        let mut action = Action::default();
        if self.is_attempt(id) {
            self.attempt = None;
            match result {
                Ok(()) => action = self.begin_load(),
                Err(e) => self.set("missing", Some(e)),
            }
        }
        if std::mem::take(&mut self.pending) {
            if let Some(next) = &self.attempt {
                action.download = Some(next.clone());
                return action;
            }
        }
        self.worker = false;
        action
    }
    /// Take the one-helper slot for a load. None = this load is stale; Some(false) =
    /// the previous helper is still exiting.
    fn reserve(&self, generation: u64, live: &AtomicUsize) -> Option<bool> {
        if !self.is_current(generation) {
            return None;
        }
        Some(
            live.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok(),
        )
    }
    /// A load finished. False = stale; the caller drops the helper.
    fn load_done(&mut self, generation: u64, result: Result<String, String>) -> bool {
        if !self.is_current(generation) {
            return false;
        }
        self.loading = false;
        match result {
            Ok(backend) => {
                self.set("ready", None);
                self.status.backend = Some(backend);
            }
            Err(e) => {
                self.kill = None;
                self.blocked = true;
                self.set("error", Some(e));
            }
        }
        true
    }
    fn take(&mut self) -> Option<(Helper, u64)> {
        if self.status.state != "ready" {
            return None;
        }
        self.helper.take().map(|h| (h, self.generation))
    }
    /// Returns the helper if it is stale.
    fn put_back(&mut self, generation: u64, helper: Helper) -> Option<Helper> {
        if self.is_current(generation) && self.helper.is_none() && self.kill.is_some() {
            self.helper = Some(helper);
            None
        } else {
            Some(helper)
        }
    }
    /// The idle helper's process exited by itself (crash, out of memory, kill -9):
    /// start a new one. One that dies quickly again counts as a failed clean.
    fn helper_exited(&mut self, generation: u64, quick: bool) -> Action {
        if !self.is_current(generation) {
            return Action::default();
        }
        if quick {
            return self.clean_failed(generation);
        }
        self.begin_load()
    }
    /// A clean failed: restart once, then give up for the session.
    fn clean_failed(&mut self, generation: u64) -> Action {
        if !self.is_current(generation) {
            return Action::default();
        }
        self.failures += 1;
        if self.failures < 2 {
            return self.begin_load();
        }
        self.blocked = true;
        let retired = self.retire();
        self.set("error", Some(GAVE_UP.into()));
        Action {
            retired,
            ..Default::default()
        }
    }
    /// Whisper is about to (re)load: free the GPU for it.
    fn whisper_loading(&mut self) -> Action {
        self.whisper_settled = false;
        if self.helper.is_none() && !self.loading && self.kill.is_none() {
            return Action::default();
        }
        let retired = self.retire();
        if matches!(self.status.state, "ready" | "loading") {
            self.set("loading", None);
        }
        Action {
            retired,
            ..Default::default()
        }
    }
}

/// Why Delulu FM's writer could not borrow the helper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerateError {
    /// Borrowed by a dictation, or still loading; try again shortly.
    Busy,
    /// Off, missing or failed; the message says what to do.
    Unavailable(String),
    /// The helper answered badly or failed.
    Writer(String),
}

/// The cleanup helper, its model download and its status.
pub struct Supervisor {
    inner: Mutex<Inner>,
    live: Arc<AtomicUsize>,
    models_dir: PathBuf,
    /// A helper binary to use instead of [`delulu_cleanup::helper_path`] (tests).
    helper: std::sync::OnceLock<PathBuf>,
    /// Called with every status change, from whichever thread made it.
    publish: Box<dyn Fn(CleanupStatus) + Send + Sync>,
}
impl Supervisor {
    pub fn new(
        enabled: bool,
        file_ready: bool,
        models_dir: PathBuf,
        publish: Box<dyn Fn(CleanupStatus) + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Supervisor {
            inner: Mutex::new(Inner::new(enabled, file_ready)),
            live: Arc::new(AtomicUsize::new(0)),
            models_dir,
            helper: std::sync::OnceLock::new(),
            publish,
        })
    }
    /// Run this helper binary instead of the installed `delulu-engine`.
    pub fn set_helper(&self, path: PathBuf) {
        let _ = self.helper.set(path);
    }

    /// Restart the helper when its process exits while idle, so a crashed or
    /// killed cleanup engine comes back without waiting for the next dictation
    /// to fail. A helper that dies while lent out is handled by that clean.
    /// The watch thread ends when the supervisor is dropped.
    pub fn watch(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("cleanup-watch".into())
            .spawn(move || loop {
                std::thread::sleep(WATCH_INTERVAL);
                let Some(this) = weak.upgrade() else { return };
                let exited = {
                    let mut inner = this.lock();
                    let generation = inner.generation;
                    inner.helper.as_mut().and_then(|h| {
                        h.cleaner
                            .exited()
                            .then(|| (generation, h.ready_at.elapsed() < QUICK_EXIT))
                    })
                };
                if let Some((generation, quick)) = exited {
                    eprintln!("cleanup: the helper exited; starting a new one");
                    let action = this.update(|i| i.helper_exited(generation, quick));
                    this.run(action);
                }
            });
        if let Err(e) = spawned {
            eprintln!("cleanup: watch thread: {e}");
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn status(&self) -> CleanupStatus {
        self.lock().status.clone()
    }
    /// Change the state and publish it.
    fn update<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        let (result, status) = {
            let mut inner = self.lock();
            let result = f(&mut inner);
            (result, inner.status.clone())
        };
        (self.publish)(status);
        result
    }

    /// Bring the helper and download in line with the settings.
    pub fn sync(self: &Arc<Self>, want: Want) {
        let action = self.update(|i| i.sync(want));
        self.run(action);
    }
    /// `start_cleanup`: load the helper, or download the model first.
    pub fn start(self: &Arc<Self>, want: Want) {
        let action = self.update(|i| i.start(want));
        self.run(action);
    }
    pub fn cancel_download(&self) {
        self.update(|i| {
            if i.cancel_download() {
                i.set("missing", Some("Download cancelled".into()));
            }
        });
    }
    /// Called before Whisper loads a model; cleanup waits until it has settled.
    pub fn whisper_loading(self: &Arc<Self>) {
        let action = self.update(|i| i.whisper_loading());
        self.run(action);
    }
    /// Blocks until no cleanup helper process is alive (or `timeout` passes), so Whisper
    /// never competes with a retired helper for GPU memory. Call it off the main thread.
    pub fn wait_released(&self, timeout: Duration) {
        let started = Instant::now();
        while self.live.load(Ordering::SeqCst) > 0 && started.elapsed() < timeout {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    /// Called when Whisper finished loading or failed.
    pub fn whisper_settled(self: &Arc<Self>, want: Want) {
        self.lock().whisper_settled = true;
        self.sync(want);
    }
    fn run(self: &Arc<Self>, action: Action) {
        action.retired.stop();
        if let Some(generation) = action.load {
            Arc::clone(self).spawn_load(generation);
        }
        if let Some(attempt) = action.download {
            Arc::clone(self).spawn_download(attempt);
        }
    }

    fn spawn_load(self: Arc<Self>, generation: u64) {
        std::thread::spawn(move || {
            let cleanup = &self;
            // One helper at a time: wait until the previous one is reaped.
            let waited = Instant::now();
            let live = loop {
                // Bind first so the guard drops before an arm locks again or sleeps.
                let reserved = cleanup.lock().reserve(generation, &cleanup.live);
                match reserved {
                    None => return,
                    Some(true) => break Live(cleanup.live.clone()),
                    Some(false) if waited.elapsed() > RETIRE_TIMEOUT => {
                        cleanup.update(|i| {
                            i.load_done(
                                generation,
                                Err("The previous cleanup helper did not stop".into()),
                            )
                        });
                        return;
                    }
                    Some(false) => std::thread::sleep(Duration::from_millis(20)),
                }
            };
            let helper = cleanup.helper.get().cloned();
            let Some(helper) = helper.or_else(delulu_cleanup::helper_path) else {
                eprintln!("cleanup: helper not found");
                cleanup.update(|i| i.load_done(generation, Err(NO_HELPER.into())));
                return;
            };
            let model = cleanup.models_dir.join(CLEANUP_MODEL.file);
            let loaded = Instant::now();
            let result = Cleaner::start(&helper, &model, LOAD_TIMEOUT, |kill| {
                let mut inner = cleanup.lock();
                if inner.is_current(generation) {
                    inner.kill = Some(kill);
                } else {
                    drop(inner);
                    kill.kill();
                }
            });
            match result {
                Ok(cleaner) => {
                    let backend = cleaner.backend().to_string();
                    eprintln!(
                        "cleanup ready backend={backend:?} load={}ms",
                        loaded.elapsed().as_millis()
                    );
                    let helper = Helper {
                        cleaner,
                        ready_at: Instant::now(),
                        _live: live,
                    };
                    let stale = cleanup.update(|i| {
                        if i.load_done(generation, Ok(backend)) {
                            i.helper = Some(helper);
                            None
                        } else {
                            Some(helper)
                        }
                    });
                    drop(stale);
                }
                Err(e) => {
                    drop(live);
                    eprintln!("cleanup load failed: {e}");
                    cleanup.update(|i| i.load_done(generation, Err(e.to_string())));
                }
            }
        });
    }

    fn spawn_download(self: Arc<Self>, mut attempt: Attempt) {
        std::thread::spawn(move || loop {
            let dir = &self.models_dir;
            let result = if delulu_models::GEMMA_4_E4B.installed(dir) {
                Ok(())
            } else {
                let id = attempt.id;
                let mut progress = |done, total| {
                    let status = {
                        let mut inner = self.lock();
                        inner
                            .progress(id, done, total)
                            .then(|| inner.status.clone())
                    };
                    if let Some(status) = status {
                        (self.publish)(status);
                    }
                };
                delulu_models::download(
                    dir,
                    &delulu_models::GEMMA_4_E4B,
                    &mut progress,
                    &attempt.cancel,
                )
                .map_err(|e| match e {
                    delulu_models::Error::Cancelled => "Download cancelled".to_string(),
                    e => format!("Download failed: {e}"),
                })
            };
            if let Err(e) = &result {
                eprintln!("cleanup download {}: {e}", attempt.id);
            }
            let mut action = self.update(|i| i.download_done(attempt.id, result));
            let next = action.download.take();
            self.run(action);
            match next {
                Some(next) => attempt = next,
                None => break,
            }
        });
    }

    /// Clean one transcript if the helper is ready right now; never waits for it.
    /// `enabled` is the Cleanup setting; `vocabulary` gives the active terms and is
    /// only read when cleanup will run.
    pub async fn clean(
        self: &Arc<Self>,
        enabled: bool,
        language: &str,
        raw: String,
        vocabulary: impl FnOnce() -> Vec<String>,
    ) -> Cleaned {
        if !enabled || delulu_cleanup::prompt(language, &raw, &[]).is_none() {
            return choose(raw, CleanResult::Skipped, 0);
        }
        let vocabulary = vocabulary();
        let Some((mut helper, generation)) = self.lock().take() else {
            return choose(raw, CleanResult::Skipped, 0);
        };
        let (language, text) = (language.to_string(), raw.clone());
        let started = Instant::now();
        let joined = tokio::task::spawn_blocking(move || {
            // On Err the helper is dropped (killed) here, off the async runtime.
            helper
                .cleaner
                .clean(&language, &text, &vocabulary)
                .map(|result| (helper, result))
        })
        .await;
        let ms = started.elapsed().as_millis() as u64;
        let error = match joined {
            Ok(Ok((helper, result))) => {
                // A result from a helper that was retired meanwhile is not used.
                let (current, stale) = {
                    let mut inner = self.lock();
                    (
                        inner.is_current(generation),
                        inner.put_back(generation, helper),
                    )
                };
                drop(stale);
                let result = if current {
                    CleanResult::Done(result)
                } else {
                    CleanResult::Failed
                };
                return choose(raw, result, ms);
            }
            Ok(Err(e)) => e.to_string(),
            Err(e) => format!("task: {e}"),
        };
        eprintln!("cleanup failed after {ms}ms: {error}");
        let action = self.update(|i| i.clean_failed(generation));
        self.run(action);
        choose(raw, CleanResult::Failed, ms)
    }

    /// Delulu FM's writer: borrow the idle helper for one prompt. Dictation never waits for
    /// it; while the radio holds the helper a dictation keeps its raw text.
    pub fn generate(
        self: &Arc<Self>,
        prompt: String,
        max_tokens: u32,
        sampling: delulu_cleanup::Sampling,
        timeout: Duration,
    ) -> Result<String, GenerateError> {
        let taken = self.lock().take();
        let Some((mut helper, generation)) = taken else {
            let status = self.status();
            return Err(match status.state {
                // Borrowed by a dictation, or still loading.
                "ready" | "loading" => GenerateError::Busy,
                _ => GenerateError::Unavailable(status.error.unwrap_or_else(|| {
                    "The cleanup model is not ready. Open Cleanup to download it.".into()
                })),
            });
        };
        match helper
            .cleaner
            .generate(prompt, max_tokens, Some(sampling), timeout)
        {
            Ok(output) => {
                let stale = self.lock().put_back(generation, helper);
                drop(stale);
                if output.truncated {
                    return Err(GenerateError::Writer("the writer ran out of room".into()));
                }
                Ok(output.text)
            }
            Err(e) => {
                drop(helper);
                let action = self.update(|i| i.clean_failed(generation));
                self.run(action);
                Err(GenerateError::Writer(format!("cleanup model: {e}")))
            }
        }
    }
}

/// What to paste and store for one dictation.
#[derive(Debug, PartialEq)]
pub struct Cleaned {
    pub text: String,
    pub raw: Option<String>,
    pub cleanup_ms: Option<u64>,
    /// What the model thought the dictation was about.
    pub topic: Option<String>,
}
#[derive(Debug)]
pub enum CleanResult {
    /// Cleanup is off, not ready, or the language isn't supported.
    Skipped,
    /// The helper answered (`None` = keep raw).
    Done(Option<delulu_cleanup::Cleaned>),
    /// The helper failed, or its result is stale.
    Failed,
}
pub fn choose(raw: String, result: CleanResult, ms: u64) -> Cleaned {
    match result {
        CleanResult::Done(Some(clean)) if clean.text != raw => Cleaned {
            text: clean.text,
            raw: Some(raw),
            cleanup_ms: Some(ms),
            topic: clean.topic,
        },
        CleanResult::Done(clean) => Cleaned {
            text: raw,
            raw: None,
            cleanup_ms: Some(ms),
            topic: clean.and_then(|c| c.topic),
        },
        CleanResult::Skipped | CleanResult::Failed => Cleaned {
            text: raw,
            raw: None,
            cleanup_ms: None,
            topic: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn want(file_ready: bool) -> Want {
        Want {
            enabled: true,
            first_run_done: true,
            model_ok: true,
            file_ready,
        }
    }

    #[test]
    fn download_attempts_are_gated_by_id() {
        let mut i = Inner::new(true, false);
        i.whisper_settled = true;
        let first = i.sync(want(false)).download.expect("auto download");
        assert_eq!(i.status.state, "downloading");
        // Progress is published only on whole-percent changes.
        let total = CLEANUP_MODEL.bytes;
        assert!(i.progress(first.id, total / 100 + 1, total));
        assert!(!i.progress(first.id, total / 100 + 2, total));
        // The automatic download runs once per session.
        assert!(i.cancel_download());
        assert!(first.cancel.load(Ordering::SeqCst));
        assert!(i.sync(want(false)).download.is_none());
        // A retry while the cancelled worker is still exiting waits for it.
        assert!(i.start(want(false)).download.is_none());
        let second = i.attempt.clone().expect("new attempt");
        assert!(!i.progress(first.id, total / 2, total));
        let handover = i.download_done(first.id, Err("Download cancelled".into()));
        assert_eq!(handover.download.map(|a| a.id), Some(second.id));
        assert_eq!(i.status.state, "downloading");
        assert!(i.worker);
        // Finishing the current attempt loads the model.
        let done = i.download_done(second.id, Ok(()));
        assert!(done.download.is_none() && done.load.is_some());
        assert!(!i.worker);
        assert_eq!(i.status.state, "loading");
    }

    #[test]
    fn upgraders_are_not_auto_downloaded() {
        let mut i = Inner::new(true, false);
        let w = Want {
            model_ok: false,
            ..want(false)
        };
        assert!(i.sync(w).download.is_none());
        assert_eq!(i.status.state, "missing");
        assert!(i.start(w).download.is_some());
    }

    #[test]
    fn generations_gate_loads_and_failures() {
        let mut i = Inner::new(true, true);
        // Nothing loads before Whisper has settled.
        assert!(i.sync(want(true)).load.is_none());
        i.whisper_settled = true;
        let first = i.sync(want(true)).load.expect("load");
        assert!(i.sync(want(true)).load.is_none(), "already loading");
        // Whisper reloads: the load in progress goes stale.
        i.whisper_loading();
        assert!(!i.load_done(first, Ok("Vulkan: test".into())));
        i.whisper_settled = true;
        let second = i.sync(want(true)).load.expect("reload");
        let live = AtomicUsize::new(1);
        assert_eq!(i.reserve(first, &live), None);
        assert_eq!(i.reserve(second, &live), Some(false));
        live.store(0, Ordering::SeqCst);
        assert_eq!(i.reserve(second, &live), Some(true));
        assert!(i.load_done(second, Ok("Vulkan: test".into())));
        assert_eq!(i.status.state, "ready");
        // First failure restarts the helper, the second gives up.
        let third = i.clean_failed(second).load.expect("restart");
        assert!(i.clean_failed(second).load.is_none(), "stale failure");
        assert!(i.load_done(third, Ok("Vulkan: test".into())));
        assert!(i.clean_failed(third).load.is_none());
        assert_eq!(i.status.state, "error");
        assert!(i.sync(want(true)).load.is_none(), "blocked");
        // Off and on again retries.
        let off = Want {
            enabled: false,
            ..want(true)
        };
        i.sync(off);
        assert_eq!(i.status.state, "off");
        assert!(i.sync(want(true)).load.is_some());
    }

    #[test]
    fn chooses_pasted_text_and_history_fields() {
        let raw = || "eh hallo".to_string();
        let done = |text: &str| {
            CleanResult::Done(Some(delulu_cleanup::Cleaned {
                text: text.into(),
                topic: Some("everyday".into()),
            }))
        };
        assert_eq!(
            choose(raw(), done("Hallo."), 300),
            Cleaned {
                text: "Hallo.".into(),
                raw: Some(raw()),
                cleanup_ms: Some(300),
                topic: Some("everyday".into()),
            }
        );
        assert_eq!(
            choose(raw(), done("eh hallo"), 300),
            Cleaned {
                text: raw(),
                raw: None,
                cleanup_ms: Some(300),
                topic: Some("everyday".into()),
            }
        );
        assert_eq!(
            choose(raw(), CleanResult::Done(None), 300),
            Cleaned {
                text: raw(),
                raw: None,
                cleanup_ms: Some(300),
                topic: None,
            }
        );
        let untouched = Cleaned {
            text: raw(),
            raw: None,
            cleanup_ms: None,
            topic: None,
        };
        assert_eq!(choose(raw(), CleanResult::Failed, 300), untouched);
        assert_eq!(choose(raw(), CleanResult::Skipped, 0), untouched);
    }
}
