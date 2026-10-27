//! The tray icon and its menu (`renderTrayMenu` and friends in
//! `electron/main.ts`). The menu is described as plain [`Entry`] values,
//! rebuilt at most every 80 ms and only re-sent when it changed, so an open
//! menu does not flicker while a download or countdown progresses.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use delulu_core::{DomainError, DomainResult};
use delulu_desktop::tray::{TrayIcon as TrayIconKind, TrayRewrite, TraySpeech, TrayUpdate};
use delulu_desktop::{menu_preview, tray_state, ShortcutMethod, TrayInputs};
use delulu_domain::speech_capabilities::supported_speech_language;
use delulu_domain::text::delivered_text;
use delulu_domain::{
    AppSettings, DictationPhase, EnginePhase, MagicPhase, MagicPreset, Page, PasteLastPhase,
    UpdatePhase, REWRITE_PRESETS, SPEECH_TIERS,
};
use delulu_voice::VoiceTrayAction;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::shell::show_main_window;
use crate::state::AppState;
use crate::updates::RELEASES_URL;

const TRAY_ID: &str = "main";

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    ToggleDictation,
    Pause,
    Resume,
    CancelRecording,
    Show(Option<Page>),
    Copy(String),
    CancelScheduledPaste,
    PasteLatest,
    Voice(VoiceTrayAction),
    SpeechUnload,
    SpeechLoad,
    MagicUnload,
    MagicLoad,
    Patch(Value),
    ConfigureShortcut,
    UpdateCheck,
    UpdateDownload,
    UpdateInstall,
    OpenReleases,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Speech,
    Rewrite,
    App,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    Item { label: String, enabled: bool, action: Option<Action> },
    Check { label: String, checked: bool, enabled: bool, action: Option<Action> },
    Separator,
    Submenu { label: String, enabled: bool, items: Vec<Entry> },
}

fn item(label: impl Into<String>, action: Action) -> Entry {
    Entry::Item { label: label.into(), enabled: true, action: Some(action) }
}

fn item_if(label: impl Into<String>, enabled: bool, action: Action) -> Entry {
    Entry::Item { label: label.into(), enabled, action: Some(action) }
}

fn disabled(label: impl Into<String>) -> Entry {
    Entry::Item { label: label.into(), enabled: false, action: None }
}

fn check(label: impl Into<String>, checked: bool, enabled: bool, action: Option<Action>) -> Entry {
    Entry::Check { label: label.into(), checked, enabled, action }
}

fn patch(value: Value) -> Action {
    Action::Patch(value)
}

#[derive(Default)]
pub struct TrayController {
    tray: Mutex<Option<TrayIcon<Wry>>>,
    actions: Mutex<Vec<Action>>,
    menu: Mutex<Option<Vec<Entry>>>,
    icon: Mutex<Option<TrayIconKind>>,
    scheduled: AtomicBool,
}

fn icon_file(kind: TrayIconKind) -> String {
    let name = kind.as_str();
    if cfg!(target_os = "macos") {
        format!("tray/tray-{name}Template.png")
    } else if cfg!(windows) {
        format!("tray/tray-{name}.ico")
    } else {
        format!("tray/tray-{name}.png")
    }
}

fn icon_image(state: &AppState, kind: TrayIconKind) -> Option<Image<'static>> {
    let path = state.paths.resource(&icon_file(kind));
    match Image::from_path(&path) {
        Ok(image) => Some(image),
        Err(error) => {
            log::warn!("Tray icon {} could not be loaded: {error}", path.display());
            None
        }
    }
}

impl TrayController {
    pub fn installed(&self) -> bool {
        self.tray.lock().is_some()
    }

    pub fn install(&self, state: &Arc<AppState>) -> tauri::Result<()> {
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("Delulu Talks")
            // On macOS a click opens the menu; also opening the window would
            // steal focus from the app the user wants to dictate into.
            .show_menu_on_left_click(!cfg!(windows))
            .icon_as_template(cfg!(target_os = "macos"))
            .on_menu_event(|app, event| {
                let Some(state) = AppState::get(app) else { return };
                let index = event.id().as_ref().strip_prefix("tray:").and_then(|id| id.parse::<usize>().ok());
                let action = index.and_then(|index| state.tray.actions.lock().get(index).cloned());
                if let Some(action) = action {
                    run_action(&state, action);
                }
            })
            .on_tray_icon_event(|tray, event| {
                if cfg!(target_os = "macos") {
                    return;
                }
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    if let Some(state) = AppState::get(tray.app_handle()) {
                        show_main_window(&state, None);
                    }
                }
            });
        if let Some(image) = icon_image(state, TrayIconKind::Idle) {
            builder = builder.icon(image);
        }
        let tray = builder.build(&state.app)?;
        *self.icon.lock() = Some(TrayIconKind::Idle);
        *self.tray.lock() = Some(tray);
        self.render(state);
        crate::shell::sync_mac_dock(state);
        Ok(())
    }

    pub fn destroy(&self, app: &AppHandle) {
        if self.tray.lock().take().is_some() {
            let _ = app.remove_tray_by_id(TRAY_ID);
        }
    }

    /// Coalesces bursts (download progress, countdowns) into one menu update.
    pub fn rebuild(&self, app: &AppHandle) {
        if !self.installed() || self.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            if let Some(state) = AppState::get(&app) {
                state.tray.scheduled.store(false, Ordering::SeqCst);
                state.tray.render(&state);
            }
        });
    }

    fn render(&self, state: &Arc<AppState>) {
        let Some(tray) = self.tray.lock().clone() else { return };
        let (entries, tray_state) = describe(state);
        let changed = self.menu.lock().as_ref() != Some(&entries);
        if changed {
            let mut actions = Vec::new();
            match build_menu(&state.app, &entries, &mut actions) {
                Ok(menu) => {
                    *self.actions.lock() = actions;
                    if let Err(error) = tray.set_menu(Some(menu)) {
                        log::warn!("Tray menu not updated: {error}");
                    } else {
                        *self.menu.lock() = Some(entries);
                    }
                }
                Err(error) => log::warn!("Tray menu not built: {error}"),
            }
        }
        let _ = tray.set_tooltip(Some(&tray_state.tooltip));
        let mut icon = self.icon.lock();
        if *icon != Some(tray_state.icon) {
            if let Some(image) = icon_image(state, tray_state.icon) {
                if tray.set_icon(Some(image)).is_ok() {
                    *icon = Some(tray_state.icon);
                    #[cfg(target_os = "macos")]
                    let _ = tray.set_icon_as_template(true);
                }
            }
        }
    }
}

fn build_menu(app: &AppHandle, entries: &[Entry], actions: &mut Vec<Action>) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for entry in entries {
        append(app, entry, actions, &|item| menu.append(item))?;
    }
    Ok(menu)
}

fn id_for(action: &Option<Action>, actions: &mut Vec<Action>) -> String {
    match action {
        Some(action) => {
            actions.push(action.clone());
            format!("tray:{}", actions.len() - 1)
        }
        None => format!("tray:none:{}", actions.len()),
    }
}

fn append(
    app: &AppHandle,
    entry: &Entry,
    actions: &mut Vec<Action>,
    add: &dyn Fn(&dyn tauri::menu::IsMenuItem<Wry>) -> tauri::Result<()>,
) -> tauri::Result<()> {
    match entry {
        Entry::Separator => add(&PredefinedMenuItem::separator(app)?),
        Entry::Item { label, enabled, action } => {
            let id = id_for(action, actions);
            add(&MenuItem::with_id(app, id, label, *enabled, None::<&str>)?)
        }
        Entry::Check { label, checked, enabled, action } => {
            let id = id_for(action, actions);
            add(&CheckMenuItem::with_id(app, id, label, *enabled, *checked, None::<&str>)?)
        }
        Entry::Submenu { label, enabled, items } => {
            let submenu = Submenu::new(app, label, *enabled)?;
            for child in items {
                append(app, child, actions, &|item| submenu.append(item))?;
            }
            add(&submenu)
        }
    }
}

fn engine_label(engine: EnginePhase, migration_required: bool) -> &'static str {
    if engine == EnginePhase::Missing && migration_required {
        return "Update runtime";
    }
    match engine {
        EnginePhase::Missing => "Setup needed",
        EnginePhase::Unloaded => "Model not loaded",
        EnginePhase::SettingUp => "Installing…",
        EnginePhase::Loading => "Loading…",
        EnginePhase::Ready => "Ready",
        EnginePhase::Error => "Needs attention",
    }
}

fn speech_menu(state: &AppState, settings: &AppSettings) -> Vec<Entry> {
    let speech = state.speech.asr.status();
    let migration = speech.migration_required == Some(true);
    let busy = state.speech.dictation.is_active()
        || matches!(speech.phase, DictationPhase::Preparing | DictationPhase::Loading | DictationPhase::Transcribing);
    let action = match speech.engine {
        EnginePhase::Ready => item_if("Unload model", !busy, Action::SpeechUnload),
        EnginePhase::Unloaded => item_if("Load model now", !busy, Action::SpeechLoad),
        _ => item_if(
            if migration { "Update speech runtime…" } else { "Set up speech…" },
            !busy,
            Action::Show(Some(Page::Models)),
        ),
    };
    let target = delulu_runtime::TargetPlatform::current();
    let mut entries = vec![disabled(engine_label(speech.engine, migration))];
    for tier in SPEECH_TIERS {
        if tier.id == delulu_domain::SpeechTier::Large && !delulu_runtime::platform::large_speech_supported(&target) {
            continue;
        }
        let selected = settings.speech_engine == tier.id;
        let language = supported_speech_language(tier.id, settings.model, &settings.language);
        entries.push(check(
            format!("{} — {}, {}", tier.name, tier.model, tier.download),
            selected,
            !busy,
            (!selected).then(|| patch(json!({ "speechEngine": tier.id, "language": language }))),
        ));
    }
    entries.push(Entry::Separator);
    entries.push(check(
        "Keep model ready",
        settings.preload_model,
        true,
        Some(patch(json!({ "preloadModel": !settings.preload_model }))),
    ));
    entries.push(action);
    entries
}

fn rewrite_menu(state: &AppState, settings: &AppSettings) -> Vec<Entry> {
    let magic = state.speech.asr.magic_status();
    let busy = matches!(magic.phase, MagicPhase::Preparing | MagicPhase::Loading | MagicPhase::Rewriting);
    let action = match magic.engine {
        EnginePhase::Ready => item_if("Unload model", !busy, Action::MagicUnload),
        EnginePhase::Unloaded => item_if("Load model now", !busy, Action::MagicLoad),
        _ => item_if("Set up rewriting…", !busy, Action::Show(Some(Page::Models))),
    };
    let mut entries =
        vec![check("Off", !settings.magic_enabled, true, Some(patch(json!({ "magicEnabled": false }))))];
    for preset in REWRITE_PRESETS {
        let mut change = json!({ "magicEnabled": true, "magicPreset": preset.id });
        if preset.id == MagicPreset::SpokenCorrections {
            change["magicAllowInferences"] = Value::Bool(false);
        }
        entries.push(check(
            preset.label,
            settings.magic_enabled && settings.magic_preset == preset.id,
            true,
            Some(patch(change)),
        ));
    }
    entries.extend([
        Entry::Separator,
        check(
            "Allow helpful assumptions",
            settings.magic_allow_inferences,
            settings.magic_preset != MagicPreset::SpokenCorrections,
            Some(patch(json!({ "magicAllowInferences": !settings.magic_allow_inferences }))),
        ),
        check(
            "Keep model ready",
            settings.preload_magic_model,
            true,
            Some(patch(json!({ "preloadMagicModel": !settings.preload_magic_model }))),
        ),
        disabled(format!("Model: {}", engine_label(magic.engine, false))),
        action,
    ]);
    entries
}

fn update_item(state: &AppState) -> Entry {
    let update = state.updates.status();
    let version = update.version.as_ref().map(|version| format!(" {version}")).unwrap_or_default();
    match update.phase {
        UpdatePhase::Unsupported => item("Get updates on GitHub…", Action::OpenReleases),
        UpdatePhase::Checking => disabled("Checking for updates…"),
        UpdatePhase::Available => item(format!("Download update{version}"), Action::UpdateDownload),
        UpdatePhase::Downloading => {
            disabled(format!("Downloading update · {}%", update.percent.unwrap_or(0.0).round() as i64))
        }
        UpdatePhase::Downloaded if state.updates.installable() => {
            item(format!("Restart to update{version}"), Action::UpdateInstall)
        }
        UpdatePhase::Downloaded => disabled("Update ready — finish your current task"),
        UpdatePhase::UpToDate => item(format!("Up to date ({})", update.current_version), Action::UpdateCheck),
        UpdatePhase::Error => item("Update failed — try again", Action::UpdateCheck),
        UpdatePhase::Idle => item("Check for updates", Action::UpdateCheck),
    }
}

fn to_tray<T: serde::de::DeserializeOwned>(value: &impl serde::Serialize) -> Option<T> {
    serde_json::to_value(value).ok().and_then(|value| serde_json::from_value(value).ok())
}

/// The menu and icon state for the current service state.
pub fn describe(state: &AppState) -> (Vec<Entry>, delulu_desktop::TrayState) {
    let settings = state.storage.get_settings();
    let status = state.speech.asr.status();
    let history = state.visible_history();
    let latest = history.first();
    let listening = matches!(status.phase, DictationPhase::Listening | DictationPhase::Paused);
    let dictation_busy =
        matches!(status.phase, DictationPhase::Preparing | DictationPhase::Loading | DictationPhase::Transcribing);
    let speech_unavailable = matches!(status.engine, EnginePhase::Missing | EnginePhase::Error);
    let shortcut = state.shortcut.status();
    let pending = state.speech.paste_last.status();

    let speech: TraySpeech = to_tray(&status).unwrap_or(TraySpeech {
        phase: delulu_desktop::tray::DictationPhase::Idle,
        engine: delulu_desktop::tray::EnginePhase::Missing,
        migration_required: None,
    });
    let rewrite: TrayRewrite =
        to_tray(&state.speech.asr.magic_status()).unwrap_or(TrayRewrite { phase: delulu_desktop::tray::MagicPhase::Idle });
    let update: Option<TrayUpdate> = to_tray(&state.updates.status());
    let icon_state = tray_state(TrayInputs {
        speech: &speech,
        rewrite: &rewrite,
        shortcut: Some(&shortcut),
        update: update.as_ref(),
        delivering: state.paste.is_busy(),
    });

    let shortcut_hint = if cfg!(target_os = "macos") || !shortcut.registered {
        String::new()
    } else {
        format!(" ({})", shortcut.accelerator)
    };
    let mut menu = vec![disabled(icon_state.status_line.clone()), Entry::Separator];
    menu.push(if listening {
        item("Stop & transcribe", Action::ToggleDictation)
    } else if speech_unavailable {
        item(
            if status.migration_required == Some(true) { "Update speech runtime…" } else { "Set up speech…" },
            Action::Show(Some(Page::Models)),
        )
    } else {
        item_if(format!("Start dictation{shortcut_hint}"), !dictation_busy, Action::ToggleDictation)
    });
    if listening {
        menu.push(if status.phase == DictationPhase::Paused {
            item("Resume", Action::Resume)
        } else {
            item("Pause", Action::Pause)
        });
        menu.push(item("Cancel recording", Action::CancelRecording));
    }
    menu.push(Entry::Separator);
    menu.push(match latest {
        Some(record) => {
            item(format!("Copy “{}”", menu_preview(delivered_text(record), 40)), Action::Copy(record.id.clone()))
        }
        None => disabled("Copy latest result"),
    });
    let mut recent: Vec<Entry> = history
        .iter()
        .take(5)
        .skip(1)
        .map(|record| item(menu_preview(delivered_text(record), 48), Action::Copy(record.id.clone())))
        .collect();
    recent.extend([Entry::Separator, item("Open logbook", Action::Show(Some(Page::History)))]);
    menu.push(Entry::Submenu { label: "Recent".into(), enabled: history.len().min(5) > 1, items: recent });
    menu.push(if pending.phase == PasteLastPhase::Pending {
        item(
            format!("Cancel scheduled paste ({}s)", delulu_domain::js::number_to_string(pending.remaining_seconds)),
            Action::CancelScheduledPaste,
        )
    } else {
        item_if(
            format!("Paste latest in {}s", delulu_domain::js::number_to_string(settings.paste_last_delay_seconds)),
            latest.is_some() && !state.speech.dictation.is_active() && pending.phase != PasteLastPhase::Delivering,
            Action::PasteLatest,
        )
    });
    let voice = state.voice.tray_items(&settings);
    if !voice.is_empty() {
        menu.push(Entry::Separator);
        menu.extend(voice.into_iter().map(|voice| item_if(voice.label, voice.enabled, Action::Voice(voice.action))));
    }
    menu.push(Entry::Separator);
    menu.push(Entry::Submenu { label: "Speech".into(), enabled: true, items: speech_menu(state, &settings) });
    let rewriting = if settings.magic_enabled {
        let label = REWRITE_PRESETS.iter().find(|preset| preset.id == settings.magic_preset).map_or("On", |p| p.label);
        format!("Rewriting: {label}")
    } else {
        "Rewriting: Off".into()
    };
    menu.push(Entry::Submenu { label: rewriting, enabled: true, items: rewrite_menu(state, &settings) });
    let mut preferences = vec![
        check("Paste automatically", settings.auto_paste, true, Some(patch(json!({ "autoPaste": !settings.auto_paste })))),
        check(
            "Keep a clipboard copy",
            settings.copy_to_clipboard,
            true,
            Some(patch(json!({ "copyToClipboard": !settings.copy_to_clipboard }))),
        ),
        check(
            "Show recording pill",
            settings.show_overlay,
            true,
            Some(patch(json!({ "showOverlay": !settings.show_overlay }))),
        ),
        check(
            "Save local history",
            settings.keep_history,
            true,
            Some(patch(json!({ "keepHistory": !settings.keep_history }))),
        ),
        Entry::Separator,
        check(
            "Launch at login",
            settings.launch_at_login,
            true,
            Some(patch(json!({ "launchAtLogin": !settings.launch_at_login }))),
        ),
    ];
    if cfg!(target_os = "macos") {
        preferences.push(check(
            "Menu bar only (hide Dock icon)",
            settings.menu_bar_only,
            true,
            Some(patch(json!({ "menuBarOnly": !settings.menu_bar_only }))),
        ));
    }
    if shortcut.method == ShortcutMethod::Portal {
        preferences.push(item("Change shortcut…", Action::ConfigureShortcut));
    }
    menu.push(Entry::Submenu { label: "Preferences".into(), enabled: true, items: preferences });
    menu.push(Entry::Separator);
    menu.push(item("Open Delulu Talks", Action::Show(None)));
    menu.push(Entry::Submenu {
        label: "Go to".into(),
        enabled: true,
        items: vec![
            item("Logbook", Action::Show(Some(Page::History))),
            item("Bottles", Action::Show(Some(Page::Lab))),
            item("Engines", Action::Show(Some(Page::Models))),
            item("Lingo", Action::Show(Some(Page::Vocabulary))),
            item("Siren", Action::Show(Some(Page::Voice))),
            item("Settings", Action::Show(Some(Page::Settings))),
        ],
    });
    menu.push(Entry::Separator);
    menu.push(update_item(state));
    menu.push(item("Quit Delulu Talks", Action::Quit));
    (menu, icon_state)
}

fn scope(action: &Action) -> Scope {
    match action {
        Action::SpeechLoad | Action::SpeechUnload => Scope::Speech,
        Action::MagicLoad | Action::MagicUnload => Scope::Rewrite,
        _ => Scope::App,
    }
}

async fn perform(state: &Arc<AppState>, action: Action) -> DomainResult<()> {
    let speech = &state.speech;
    match action {
        Action::ToggleDictation => speech.dictation.toggle(),
        Action::Pause => speech.dictation.pause(),
        Action::Resume => speech.dictation.resume(),
        Action::CancelRecording => speech.dictation.cancel(),
        Action::Show(page) => show_main_window(state, page),
        Action::Copy(id) => {
            if let Some(record) = state.lookup(&id) {
                speech.copy_transcript(&record).await?;
            }
        }
        Action::CancelScheduledPaste => speech.paste_last.cancel_pending("Scheduled paste cancelled from the tray."),
        Action::PasteLatest => {
            speech.schedule_paste_last()?;
        }
        Action::Voice(action) => {
            if let Some(message) = state.voice.tray_action(action).await {
                state.notify(&message);
            }
        }
        Action::SpeechUnload => speech.asr.unload().await?,
        Action::SpeechLoad => speech.asr.load_model(&state.storage.get_settings()).await?,
        Action::MagicUnload => speech.asr.unload_magic().await?,
        Action::MagicLoad => speech.asr.load_magic(&state.storage.get_settings()).await?,
        Action::Patch(value) => {
            crate::settings::persist_settings(state, value).await?;
        }
        Action::ConfigureShortcut => state.shortcut.configure().await?,
        Action::UpdateCheck => {
            state.updates.check().await;
        }
        Action::UpdateDownload => {
            state.updates.download().await;
        }
        Action::UpdateInstall => state.updates.install()?,
        Action::OpenReleases => {
            use tauri_plugin_opener::OpenerExt;
            state.app.opener().open_url(RELEASES_URL, None::<&str>).map_err(|error| DomainError::failed(error.to_string()))?;
        }
        Action::Quit => crate::shell::quit(&state.app),
    }
    Ok(())
}

/// `runTrayAction`: model actions report through their engine status;
/// everything else is shown as a notification, so a refused tray click
/// never marks the speech engine broken.
pub fn run_action(state: &Arc<AppState>, action: Action) {
    let state = Arc::clone(state);
    tauri::async_runtime::spawn(async move {
        let scope = scope(&action);
        if let Err(error) = perform(&state, action).await {
            match scope {
                Scope::Speech => state.speech.asr.fail(&error),
                Scope::Rewrite => state.speech.asr.fail_magic(&error),
                Scope::App => state.notify(&error.message),
            }
            state.rebuild_tray();
        }
    });
}
