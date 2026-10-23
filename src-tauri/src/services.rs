//! Builds every service and wires their callbacks (`start()` in
//! `electron/main.ts`). Runs inside the Tokio runtime: speech, voice and the
//! import queue capture the current runtime handle.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use delulu_audio::{Cues, DeviceWatcher};
use delulu_core::{AppPaths, DomainResult, SharedSink};
use delulu_data::audio_cache_recovery::{recover_temporary_audio, AudioCacheRecovery};
use delulu_data::history_batch::HistoryBatchDeletion;
use delulu_data::model_cache::ModelCacheService;
use delulu_data::rule_usage::RuleUsageService;
use delulu_data::StorageService;
use delulu_desktop::{
    default_global_shortcuts_portal, ClipboardBackend, DesktopEnv, MacPillFactory, PasteIo, PasteService, PillIo,
    PillService, ShortcutMode, ShortcutService, SystemClipboard,
};
use delulu_domain::HistoryDeletionPhase;
use delulu_runtime::setup_snapshot::SetupSnapshots;
use delulu_runtime::SerialQueue;
use delulu_speech::{Speech, SpeechDeps, SpeechHooks};
use delulu_voice::{VoiceSystem, VoiceSystemConfig};
use parking_lot::Mutex;
use tauri::AppHandle;

use crate::events::TauriSink;
use crate::handlers::history::deleted_despite_cleanup;
use crate::ipc::Router;
use crate::lab::Lab;
use crate::profile::{AppProfile, SpeechTranscriber};
use crate::shell::Shell;
use crate::state::AppState;
use crate::tray::TrayController;
use crate::updates::{self_update_supported, UpdateService};

fn rebuild_tray(app: &AppHandle) {
    if let Some(state) = AppState::get(app) {
        state.rebuild_tray();
    }
}

fn paste_shortcut(value: delulu_domain::PasteShortcut) -> delulu_desktop::PasteShortcut {
    match value {
        delulu_domain::PasteShortcut::Terminal => delulu_desktop::PasteShortcut::Terminal,
        _ => delulu_desktop::PasteShortcut::Standard,
    }
}

fn shortcut_mode(value: delulu_domain::ShortcutMode) -> ShortcutMode {
    match value {
        delulu_domain::ShortcutMode::Hold => ShortcutMode::Hold,
        _ => ShortcutMode::Toggle,
    }
}

pub struct Built {
    pub state: Arc<AppState>,
    pub audio_recovery: AudioCacheRecovery,
}

pub fn build(
    app: &AppHandle,
    paths: AppPaths,
    router: Arc<Router<AppState>>,
    start_hidden: bool,
) -> DomainResult<Built> {
    let sink: SharedSink = Arc::new(TauriSink::new(app.clone()));
    let storage = Arc::new(StorageService::open(paths.clone())?);
    if let Err(error) = storage.enforce_history_limit() {
        log::error!("History limit was not applied: {}", error.message);
    }
    let rule_usage = Arc::new(RuleUsageService::new(&paths.data));
    let model_cache = ModelCacheService::new(paths.models());
    // Only this instance holds the single-instance lock, and no worker,
    // capture or import exists yet while prior-session WAVs are inspected.
    let audio_recovery = recover_temporary_audio(&paths.audio_cache(), delulu_core::now_ms());

    let profile = Arc::new(AppProfile {
        app: app.clone(),
        storage: storage.clone(),
        rule_usage: rule_usage.clone(),
        sink: sink.clone(),
        deletion: OnceLock::new(),
    });
    let clipboard = Arc::new(SystemClipboard::new());
    log::info!("Clipboard backend: {}", clipboard.backend_name());

    let paste = {
        let (load_token, save_token) = Speech::paste_portal_hooks(profile.clone());
        let mut io = PasteIo::system(clipboard.clone() as Arc<dyn ClipboardBackend>);
        let settings = storage.clone();
        io.shortcut = Arc::new(move || paste_shortcut(settings.get_settings().paste_shortcut));
        io.load_restore_token = load_token;
        io.save_restore_token = save_token;
        PasteService::new(io)
    };
    let mac: Option<Arc<dyn MacPillFactory>> = if cfg!(target_os = "macos") {
        Some(Arc::new(crate::mac_pill::TauriMacPillFactory(app.clone())))
    } else {
        None
    };
    let pill = PillService::new(PillIo::system(&paths, mac));
    if storage.get_settings().show_overlay {
        pill.prepare();
    }

    let voice_cell: Arc<OnceLock<VoiceSystem>> = Arc::new(OnceLock::new());
    let hooks = {
        let before = voice_cell.clone();
        let listening = voice_cell.clone();
        let finished = voice_cell.clone();
        let status_app = app.clone();
        let changed_app = app.clone();
        SpeechHooks {
            before_capture: Arc::new(move || {
                if let Some(voice) = before.get() {
                    voice.before_dictation_capture();
                }
            }),
            // A listening session keeps the speech model loaded between turns.
            listening_active: Arc::new(move || listening.get().is_some_and(|voice| voice.listening().active())),
            runtime_status: Arc::new(move |dictation_active| {
                if !dictation_active {
                    if let Some(voice) = finished.get() {
                        voice.dictation_finished();
                    }
                }
                rebuild_tray(&status_app);
            }),
            changed: Arc::new(move || rebuild_tray(&changed_app)),
            ..SpeechHooks::default()
        }
    };
    let speech = Arc::new(Speech::new(SpeechDeps {
        paths: paths.clone(),
        profile: profile.clone(),
        sink: sink.clone(),
        paste: paste.clone(),
        pill: Arc::new(pill.clone()),
        hooks,
    }));

    let deletion = {
        let commit_storage = storage.clone();
        let transcripts = speech.transcripts.clone();
        let pin_storage = storage.clone();
        let changed_app = app.clone();
        HistoryBatchDeletion::new(
            move |ids| {
                // Publish the durable snapshot before invalidating any session records.
                let failure = deleted_despite_cleanup(commit_storage.delete_history_selection(ids))?;
                transcripts.forget(ids);
                failure.map_or(Ok(()), Err)
            },
            move |report| {
                let pinned = report
                    .as_ref()
                    .filter(|state| state.phase == HistoryDeletionPhase::Pending)
                    .map(|state| state.ids.clone())
                    .unwrap_or_default();
                pin_storage.pin_history(&pinned);
                if let Some(state) = AppState::get(&changed_app) {
                    state.emit("history:batchChanged", &state.history_batch_snapshot(report));
                    state.rebuild_tray();
                }
            },
        )
    };
    let _ = profile.deletion.set(deletion.clone());

    let voice = {
        let tray_app = app.clone();
        VoiceSystem::new(VoiceSystemConfig {
            profile: profile.clone(),
            transcriber: Arc::new(SpeechTranscriber { asr: speech.asr.clone(), storage: storage.clone() }),
            sink: sink.clone(),
            clipboard: clipboard.clone(),
            app_version: app.package_info().version.to_string(),
            on_tray_change: Some(Arc::new(move || rebuild_tray(&tray_app))),
        })
    };
    let coordinator_provision = Arc::new(tokio::sync::Mutex::new(()));
    voice.set_coordinator_model(Arc::new(crate::profile::LocalCoordinator {
        worker: delulu_speech::CoordinatorWorker::new(paths.clone()),
        profile: profile.clone(),
        asr: speech.asr.clone(),
        provision: coordinator_provision.clone(),
    }));
    let _ = voice_cell.set(voice.clone());

    let shortcut = {
        let settings = storage.clone();
        let service = ShortcutService::new(
            &DesktopEnv::current(),
            Arc::new(move || shortcut_mode(settings.get_settings().shortcut_mode)),
            Arc::new(speech.dictation.clone()),
            default_global_shortcuts_portal(),
            Arc::new(crate::shortcuts::TauriShortcuts(app.clone())),
        );
        let status_sink = sink.clone();
        let status_app = app.clone();
        service.on_status(move |status| {
            delulu_core::emit(status_sink.as_ref(), "shortcut:statusChanged", status);
            rebuild_tray(&status_app);
        });
        service
    };

    let settings_queue = SerialQueue::new();
    let updates = {
        let publish_sink = sink.clone();
        let publish_app = app.clone();
        let install_app = app.clone();
        UpdateService::new(
            app.clone(),
            self_update_supported(paths.packaged),
            app.package_info().version.to_string(),
            move |status| {
                delulu_core::emit(publish_sink.as_ref(), "updates:statusChanged", status);
                rebuild_tray(&publish_app);
            },
            move || {
                AppState::get(&install_app).is_some_and(|state| {
                    !state.speech.dictation.is_active()
                        && !state.speech.asr.is_busy()
                        && !state.paste.is_busy()
                        && !state.settings_queue.busy()
                })
            },
        )
    };

    let device_watcher = {
        let device_sink = sink.clone();
        DeviceWatcher::spawn(Duration::from_secs(2), move |lists| {
            delulu_core::emit(device_sink.as_ref(), "audio:inputsChanged", &lists.inputs);
        })
    };

    let lab = Lab::new(paths.data.clone(), speech.clone(), sink.clone());
    let state = Arc::new(AppState {
        app: app.clone(),
        paths,
        router,
        sink,
        storage,
        speech,
        voice,
        paste,
        pill,
        shortcut,
        rule_usage,
        model_cache,
        deletion,
        settings_queue,
        coordinator_provision,
        updates,
        lab,
        shell: Shell::new(start_hidden),
        tray: TrayController::default(),
        setup_snapshots: SetupSnapshots::new(),
        cues: Cues::new(),
        retention_preview: Mutex::new(None),
        encrypted_history_busy: AtomicBool::new(false),
        device_watcher: Mutex::new(Some(device_watcher)),
    });
    Ok(Built { state, audio_recovery })
}
