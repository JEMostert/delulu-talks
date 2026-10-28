//! Transcript cleanup: the helper process, its model download and the dictation hook.
//! Every miss falls back to the raw Whisper text; dictation never waits for cleanup.
use super::*;
use delulu_cleanup::{Cleaner, CleanerKill};
use std::sync::atomic::AtomicUsize;

pub(crate) static CLEANUP_MODEL: delulu_stt::ModelInfo = delulu_stt::ModelInfo {
    id: delulu_cleanup::MODEL_ID,
    label: "Gemma 4 E4B (text cleanup)",
    file: delulu_cleanup::MODEL_FILE,
    url: delulu_cleanup::MODEL_URL,
    sha256: delulu_cleanup::MODEL_SHA256,
    bytes: delulu_cleanup::MODEL_BYTES,
};
/// The first Vulkan run compiles shaders.
const LOAD_TIMEOUT: Duration = Duration::from_secs(180);
/// How long a new helper waits for the previous one to be reaped.
const RETIRE_TIMEOUT: Duration = Duration::from_secs(30);
const NO_HELPER: &str =
    "The cleanup helper (delulu-cleanup) is not installed; dictation uses the raw text.";
const GAVE_UP: &str =
    "Cleanup was too slow or failed; using raw text. Turn it off and on to retry.";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupStatus {
    pub(crate) state: &'static str,
    pub(crate) done_bytes: u64,
    pub(crate) total_bytes: u64,
    pub(crate) error: Option<String>,
    pub(crate) backend: Option<String>,
}

/// A running helper. `_live` holds the one-helper slot until the process is reaped,
/// so it is declared after `cleaner` and dropped last.
pub(crate) struct Helper {
    cleaner: Cleaner,
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
pub(crate) struct Want {
    enabled: bool,
    first_run_done: bool,
    model_ok: bool,
    file_ready: bool,
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

pub(crate) fn percent(done: u64, total: u64) -> u64 {
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

pub(crate) struct Cleanup {
    inner: Mutex<Inner>,
    live: Arc<AtomicUsize>,
}
impl Cleanup {
    pub(crate) fn new(enabled: bool, file_ready: bool) -> Self {
        Cleanup {
            inner: Mutex::new(Inner::new(enabled, file_ready)),
            live: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn status(&self) -> CleanupStatus {
        self.lock().status.clone()
    }
    /// Change the state and publish it.
    fn update<R>(&self, app: &tauri::AppHandle, f: impl FnOnce(&mut Inner) -> R) -> R {
        let (result, status) = {
            let mut inner = self.lock();
            let result = f(&mut inner);
            (result, inner.status.clone())
        };
        let _ = app.emit("cleanup-status", status);
        result
    }
}

fn want(s: &Shell) -> Want {
    let settings = s.store.settings();
    Want {
        enabled: settings.cleanup,
        first_run_done: s.store.state().first_run_done,
        model_ok: settings.cleanup_model_ok,
        file_ready: delulu_stt::file_ready(&s.store.models_dir(), &CLEANUP_MODEL),
    }
}
/// Bring the helper and download in line with the settings.
pub(crate) fn sync(app: &tauri::AppHandle) {
    let s = app.state::<Shell>();
    let want = want(&s);
    let action = s.cleanup.update(app, |i| i.sync(want));
    run(app, action);
}
/// `start_cleanup`: load the helper, or download the model first.
pub(crate) fn start(app: &tauri::AppHandle) {
    let s = app.state::<Shell>();
    let want = want(&s);
    let action = s.cleanup.update(app, |i| i.start(want));
    run(app, action);
}
pub(crate) fn cancel_download(app: &tauri::AppHandle) {
    app.state::<Shell>().cleanup.update(app, |i| {
        if i.cancel_download() {
            i.set("missing", Some("Download cancelled".into()));
        }
    });
}
/// Called before Whisper loads a model; cleanup waits until it has settled.
pub(crate) fn whisper_loading(app: &tauri::AppHandle) {
    let action = app
        .state::<Shell>()
        .cleanup
        .update(app, |i| i.whisper_loading());
    run(app, action);
}
/// Called when Whisper finished loading or failed.
pub(crate) fn whisper_settled(app: &tauri::AppHandle) {
    app.state::<Shell>().cleanup.lock().whisper_settled = true;
    sync(app);
}
fn run(app: &tauri::AppHandle, action: Action) {
    action.retired.stop();
    if let Some(generation) = action.load {
        spawn_load(app.clone(), generation);
    }
    if let Some(attempt) = action.download {
        spawn_download(app.clone(), attempt);
    }
}

fn spawn_load(app: tauri::AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let s = app.state::<Shell>();
        let cleanup = &s.cleanup;
        // One helper at a time: wait until the previous one is reaped.
        let waited = Instant::now();
        let live = loop {
            match cleanup.lock().reserve(generation, &cleanup.live) {
                None => return,
                Some(true) => break Live(cleanup.live.clone()),
                Some(false) if waited.elapsed() > RETIRE_TIMEOUT => {
                    cleanup.update(&app, |i| {
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
        let Some(helper) = delulu_cleanup::helper_path() else {
            eprintln!("cleanup: helper not found");
            cleanup.update(&app, |i| i.load_done(generation, Err(NO_HELPER.into())));
            return;
        };
        let model = s.store.models_dir().join(CLEANUP_MODEL.file);
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
                    _live: live,
                };
                let stale = cleanup.update(&app, |i| {
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
                cleanup.update(&app, |i| i.load_done(generation, Err(e.to_string())));
            }
        }
    });
}

fn spawn_download(app: tauri::AppHandle, mut attempt: Attempt) {
    std::thread::spawn(move || loop {
        let s = app.state::<Shell>();
        let dir = s.store.models_dir();
        let result = if delulu_stt::file_ready(&dir, &CLEANUP_MODEL) {
            Ok(())
        } else {
            let id = attempt.id;
            let mut progress = |done, total| {
                let status = {
                    let mut inner = s.cleanup.lock();
                    inner
                        .progress(id, done, total)
                        .then(|| inner.status.clone())
                };
                if let Some(status) = status {
                    let _ = app.emit("cleanup-status", status);
                }
            };
            delulu_stt::download_file(&dir, &CLEANUP_MODEL, &mut progress, &attempt.cancel)
                .map(|_| ())
                .map_err(|e| match e {
                    delulu_stt::SttError::Cancelled => "Download cancelled".to_string(),
                    e => format!("Download failed: {e}"),
                })
        };
        if let Err(e) = &result {
            eprintln!("cleanup download {}: {e}", attempt.id);
        }
        let mut action = s
            .cleanup
            .update(&app, |i| i.download_done(attempt.id, result));
        let next = action.download.take();
        run(&app, action);
        match next {
            Some(next) => attempt = next,
            None => break,
        }
    });
}

/// What to paste and store for one dictation.
#[derive(Debug, PartialEq)]
pub(crate) struct Cleaned {
    pub(crate) text: String,
    pub(crate) raw: Option<String>,
    pub(crate) cleanup_ms: Option<u64>,
}
#[derive(Debug)]
pub(crate) enum CleanResult {
    /// Cleanup is off, not ready, or the language isn't supported.
    Skipped,
    /// The helper answered (`None` = keep raw).
    Done(Option<String>),
    /// The helper failed, or its result is stale.
    Failed,
}
pub(crate) fn choose(raw: String, result: CleanResult, ms: u64) -> Cleaned {
    match result {
        CleanResult::Done(Some(text)) if text != raw => Cleaned {
            text,
            raw: Some(raw),
            cleanup_ms: Some(ms),
        },
        CleanResult::Done(_) => Cleaned {
            text: raw,
            raw: None,
            cleanup_ms: Some(ms),
        },
        CleanResult::Skipped | CleanResult::Failed => Cleaned {
            text: raw,
            raw: None,
            cleanup_ms: None,
        },
    }
}

/// Clean one transcript if the helper is ready right now; never waits for it.
pub(crate) async fn clean(app: &tauri::AppHandle, language: &str, raw: String) -> Cleaned {
    let s = app.state::<Shell>();
    if !s.store.settings().cleanup || delulu_cleanup::prompt(language, &raw).is_none() {
        return choose(raw, CleanResult::Skipped, 0);
    }
    let Some((mut helper, generation)) = s.cleanup.lock().take() else {
        return choose(raw, CleanResult::Skipped, 0);
    };
    let (language, text) = (language.to_string(), raw.clone());
    let started = Instant::now();
    let joined = tokio::task::spawn_blocking(move || {
        // On Err the helper is dropped (killed) here, off the async runtime.
        helper
            .cleaner
            .clean(&language, &text)
            .map(|result| (helper, result))
    })
    .await;
    let ms = started.elapsed().as_millis() as u64;
    let error = match joined {
        Ok(Ok((helper, result))) => {
            // A result from a helper that was retired meanwhile is not used.
            let current = s.cleanup.lock().is_current(generation);
            let stale = s.cleanup.lock().put_back(generation, helper);
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
    let action = s.cleanup.update(app, |i| i.clean_failed(generation));
    run(app, action);
    choose(raw, CleanResult::Failed, ms)
}

#[tauri::command]
pub(crate) fn get_cleanup_status(s: State<'_, Shell>) -> CleanupStatus {
    s.cleanup.status()
}
#[tauri::command]
pub(crate) fn start_cleanup(app: tauri::AppHandle, s: State<'_, Shell>) -> Result<(), String> {
    let mut settings = s.store.settings();
    if !settings.cleanup_model_ok {
        settings.cleanup_model_ok = true;
        s.store
            .save_settings(&settings)
            .map_err(|e| e.to_string())?;
    }
    start(&app);
    Ok(())
}
#[tauri::command]
pub(crate) fn cancel_cleanup_download(app: tauri::AppHandle) {
    cancel_download(&app);
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
    fn chooses_pasted_text_and_history_fields() {
        let raw = || "eh hallo".to_string();
        assert_eq!(
            choose(raw(), CleanResult::Done(Some("Hallo.".into())), 300),
            Cleaned {
                text: "Hallo.".into(),
                raw: Some(raw()),
                cleanup_ms: Some(300)
            }
        );
        let unchanged = Cleaned {
            text: raw(),
            raw: None,
            cleanup_ms: Some(300),
        };
        assert_eq!(
            choose(raw(), CleanResult::Done(Some(raw())), 300),
            unchanged
        );
        assert_eq!(choose(raw(), CleanResult::Done(None), 300), unchanged);
        let untouched = Cleaned {
            text: raw(),
            raw: None,
            cleanup_ms: None,
        };
        assert_eq!(choose(raw(), CleanResult::Failed, 300), untouched);
        assert_eq!(choose(raw(), CleanResult::Skipped, 0), untouched);
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
}
