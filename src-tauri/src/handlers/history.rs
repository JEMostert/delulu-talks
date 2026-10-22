//! `electron/ipc/history.ts`: saved and session transcripts, staged batch
//! deletion, retention, exports and encrypted backups.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use delulu_core::{now_ms, uuid, DomainError, DomainResult};
use delulu_data::encrypted_history::{decrypt_history, encrypt_history};
use delulu_data::history_batch::history_selection;
use delulu_data::history_retention::{
    affected_by_retention, history_fingerprint_value, retention_effects, validate_retention_policy,
};
use delulu_data::migration_backups::is_history_backup_cleanup_error;
use delulu_data::storage::apply_transcript_edit;
use delulu_data::transcripts::{default_export_name, export_record, export_selection, write_export_file};
use delulu_domain::pipeline_timings::{normalize_timings, without_rewrite_timings};
use delulu_domain::text::{delivered_text, transcript_source_revision};
use delulu_domain::{ExportFormat, HistoryRetentionPreview, TranscriptRecord};
use serde_json::{json, Map, Value};

use crate::dialogs::{self, Filter};
use crate::handlers::blocking;
use crate::ipc::Router;
use crate::state::{plain, AppState, RetentionPreview};

/// `deletedDespiteCleanup`: a backup-cleanup failure means the deletion
/// itself was saved; the caller updates session state, then reports it.
pub fn deleted_despite_cleanup(result: DomainResult<()>) -> DomainResult<Option<DomainError>> {
    match result {
        Ok(()) => Ok(None),
        Err(error) if is_history_backup_cleanup_error(&error) => Ok(Some(error)),
        Err(error) => Err(error),
    }
}

fn save_export(state: &AppState, path: &std::path::Path, content: &str) -> DomainResult<()> {
    write_export_file(&state.paths.data, path, content)
}

/// `retentionHistoryFingerprint`: saved records and session copies.
fn full_fingerprint(state: &AppState) -> String {
    let session: Vec<Value> =
        state.speech.transcripts.session_records().iter().filter_map(|record| serde_json::to_value(record).ok()).collect();
    history_fingerprint_value(&json!({ "saved": state.storage.history_json(), "session": session }))
}

/// Records an edited copy in the session cache and as the latest transcript.
fn remember(state: &AppState, record: TranscriptRecord) -> TranscriptRecord {
    state.speech.transcripts.remember(record.clone());
    record
}

fn set_or_remove(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            map.insert(key.to_owned(), value);
        }
        None => {
            map.remove(key);
        }
    }
}

/// `history:setRewrite`'s record change; `rewrite` is the validated result or null.
fn with_rewrite(record: &TranscriptRecord, rewrite: &Value) -> DomainResult<TranscriptRecord> {
    let mut map = match serde_json::to_value(record)? {
        Value::Object(map) => map,
        _ => return Err(plain("Invalid rewrite")),
    };
    let timings = record.timings.as_ref().map(serde_json::to_value).transpose()?.unwrap_or(Value::Null);
    let base = without_rewrite_timings(&timings);
    if rewrite.is_null() {
        for key in ["magicText", "rewriteSourceRevision", "magicModel", "magicPreset"] {
            map.insert(key.into(), Value::Null);
        }
        map.insert("magicIncludedInferences".into(), Value::Bool(false));
        map.insert("magicProcessingTimeMs".into(), json!(0));
        set_or_remove(&mut map, "timings", base.map(serde_json::to_value).transpose()?);
    } else {
        let measured = rewrite.get("timings").and_then(normalize_timings);
        let mut timings = base.map(serde_json::to_value).transpose()?.unwrap_or_else(|| json!({}));
        if let Some(fields) = timings.as_object_mut() {
            let measured = measured.map(serde_json::to_value).transpose()?.unwrap_or(Value::Null);
            for key in ["rewriteLoadMs", "rewritingMs"] {
                set_or_remove(fields, key, measured.get(key).cloned());
            }
        }
        map.insert("magicText".into(), rewrite.get("text").cloned().unwrap_or(Value::Null));
        map.insert("rewriteSourceRevision".into(), json!(transcript_source_revision(record)));
        map.insert("magicPreset".into(), rewrite.get("preset").cloned().unwrap_or(Value::Null));
        map.insert("magicModel".into(), rewrite.get("model").cloned().unwrap_or(Value::Null));
        map.insert(
            "magicIncludedInferences".into(),
            Value::Bool(rewrite.get("includedInferences") == Some(&Value::Bool(true))),
        );
        map.insert("magicProcessingTimeMs".into(), rewrite.get("processingTimeMs").cloned().unwrap_or(json!(0)));
        // Earlier rewrite and delivery timings described different text.
        set_or_remove(&mut map, "timings", normalize_timings(&timings).map(serde_json::to_value).transpose()?);
    }
    Ok(serde_json::from_value(Value::Object(map))?)
}

fn format_of(value: &str) -> ExportFormat {
    match value {
        "json" => ExportFormat::Json,
        "md" => ExportFormat::Md,
        _ => ExportFormat::Txt,
    }
}

async fn save_backup(state: &AppState, text: &str, extension: &str, title: &str) -> DomainResult<Option<String>> {
    let filter = Filter { name: "History backup", extensions: &[extension] };
    let Some(path) = dialogs::save(&state.app, title, &format!("delulu-history.{extension}"), filter).await? else {
        return Ok(None);
    };
    save_export(state, &path, text)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// One encrypted-history operation at a time.
struct Exclusive<'a>(&'a AppState);

impl<'a> Exclusive<'a> {
    fn take(state: &'a AppState) -> DomainResult<Self> {
        if state.encrypted_history_busy.swap(true, Ordering::SeqCst) {
            return Err(plain("An encrypted-history operation is already running."));
        }
        Ok(Self(state))
    }
}

impl Drop for Exclusive<'_> {
    fn drop(&mut self) {
        self.0.encrypted_history_busy.store(false, Ordering::SeqCst);
    }
}

fn read_backup(path: PathBuf) -> DomainResult<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(&path)?;
    let info = file.metadata()?;
    if !info.is_file() || info.len() > 90 * 1024 * 1024 {
        return Err(plain("Choose an encrypted-history file smaller than 90 MB."));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

pub fn register(router: &mut Router<AppState>) {
    router
        .handle("history:batchSnapshot", |state, _| async move {
            Ok(state.history_batch_snapshot(state.deletion.get_state()))
        })
        .handle("history:stageDeletion", |state, args| async move {
            let ids = history_selection(&args.get::<Value>(0)?)?;
            state.selected_history(&ids)?; // All-or-nothing if any selection is stale.
            state.deletion.stage(ids)
        })
        .handle("history:undoDeletion", |state, args| async move {
            let token: String = args.get(0)?;
            state.deletion.undo(&token)
        })
        .handle("history:exportSelection", |state, args| async move {
            let ids = history_selection(&args.get::<Value>(0)?)?;
            let format = match args.get::<String>(1)?.as_str() {
                "txt" => ExportFormat::Txt,
                "json" => ExportFormat::Json,
                _ => return Err(plain("Choose TXT or JSON export.")),
            };
            let records = state.selected_history_json(&ids)?;
            let fingerprint = history_fingerprint_value(&Value::Array(records.clone()));
            let upper = format.as_str().to_uppercase();
            let filter = Filter { name: &upper, extensions: &[format.as_str()] };
            let title = format!("Export {} transcripts as {upper}", records.len());
            let name = format!("delulu-{}-transcripts.{}", records.len(), format.as_str());
            let Some(path) = dialogs::save(&state.app, &title, &name, filter).await? else { return Ok(None) };
            let current = state.selected_history_json(&ids)?;
            if history_fingerprint_value(&Value::Array(current)) != fingerprint {
                return Err(plain(
                    "Selected transcripts changed while choosing a file. Export the current selection again.",
                ));
            }
            save_export(&state, &path, &export_selection(&records, format)?)?;
            Ok(Some(path.to_string_lossy().into_owned()))
        })
        .handle("history:encryptedExport", |state, args| async move {
            let passphrase: Value = args.get(0)?;
            let _turn = Exclusive::take(&state)?;
            let history = state.storage.history_json();
            let encoded = blocking(move || encrypt_history(&history, &passphrase)).await?;
            save_backup(&state, &encoded, "delulubak", "Save encrypted history").await
        })
        .handle("history:encryptedRecover", |state, args| async move {
            let passphrase: Value = args.get(0)?;
            let _turn = Exclusive::take(&state)?;
            let filter = Filter { name: "Encrypted history", extensions: &["delulubak"] };
            let chosen = dialogs::open(&state.app, "Choose encrypted history backup", filter, false).await;
            let Some(path) = chosen.into_iter().next() else { return Ok(None) };
            let decoded = blocking(move || decrypt_history(&read_backup(path)?, &passphrase)).await?;
            save_backup(&state, &decoded, "json", "Save decrypted history outside the active profile").await
        })
        .handle("history:get", |state, _| async move { Ok(state.visible_history()) })
        .handle("history:retentionPreview", |state, args| async move {
            state.deletion.assert_no_pending()?;
            let policy = validate_retention_policy(&args.get::<Value>(0)?)?;
            let saved = state.storage.get_history();
            let previewed_at = now_ms();
            let affected = affected_by_retention(&saved, &policy, previewed_at as f64);
            let preview = HistoryRetentionPreview {
                token: uuid(),
                policy,
                previewed_at,
                total_saved: saved.len() as u64,
                retained_count: (saved.len() - affected.len()) as u64,
                effects: retention_effects(affected.iter().map(|item| &item.record)),
                affected,
            };
            *state.retention_preview.lock() = Some(RetentionPreview {
                preview: preview.clone(),
                saved_fingerprint: state.storage.history_fingerprint(),
                full_fingerprint: full_fingerprint(&state),
            });
            Ok(preview)
        })
        .handle("history:retentionApply", |state, args| async move {
            state.deletion.assert_no_pending()?;
            let token: String = args.get(0)?;
            let mut slot = state.retention_preview.lock();
            let Some(pending) = slot.as_ref().filter(|pending| pending.preview.token == token) else {
                return Err(plain("This retention preview is no longer available. Preview the records again."));
            };
            if full_fingerprint(&state) != pending.full_fingerprint {
                *slot = None;
                return Err(plain(
                    "History changed since the preview. Preview the affected records again; nothing was removed.",
                ));
            }
            let removed: Vec<String> = pending.preview.affected.iter().map(|item| item.record.id.clone()).collect();
            if !removed.is_empty() {
                // No await between snapshot comparison, durable write and session invalidation.
                state.storage.apply_history_retention(&pending.saved_fingerprint, &removed)?;
                state.speech.transcripts.forget(&removed);
            }
            *slot = None;
            drop(slot);
            state.emit("history:retentionApplied", &removed);
            state.rebuild_tray();
            Ok(removed)
        })
        .handle("history:updateTranscript", |state, args| async move {
            let id: String = args.get(0)?;
            let text: Option<String> = args.get(1)?;
            state.assert_visible(&id)?;
            let updated = if state.storage.contains_history(&id) {
                state.storage.update_transcript(&id, text.as_deref())?
            } else if let Some(record) = state.speech.transcripts.session(&id) {
                apply_transcript_edit(&record, text.as_deref())?
            } else {
                return Err(plain("Transcript not found"));
            };
            Ok(remember(&state, updated))
        })
        .handle("history:setTitle", |state, args| async move {
            let id: String = args.get(0)?;
            let title: Value = args.get(1)?;
            state.assert_visible(&id)?;
            let normalized = delulu_domain::text::normalize_transcript_title(&title)?;
            let updated = if state.storage.contains_history(&id) {
                state.storage.set_transcript_title(&id, normalized.as_deref())?
            } else if let Some(record) = state.speech.transcripts.session(&id) {
                TranscriptRecord { title: Some(normalized), ..record }
            } else {
                return Err(plain("Transcript not found"));
            };
            // A rejected saved-history write leaves session and last-record state intact.
            Ok(remember(&state, updated))
        })
        .handle("history:setRewrite", |state, args| async move {
            let id: String = args.get(0)?;
            let rewrite: Value = args.get(1)?;
            let expected: String = args.get(2)?;
            let revision = args.raw(3).cloned().unwrap_or(Value::Null);
            state.assert_visible(&id)?;
            let record = state.lookup(&id).ok_or_else(|| plain("Transcript not found"))?;
            let revision = if revision.is_null() { Some(0.0) } else { revision.as_f64() };
            let Some(revision) = revision.filter(|value| value.fract() == 0.0 && *value >= 0.0 && *value <= 9007199254740991.0)
            else {
                return Err(plain("Invalid transcript source revision"));
            };
            if transcript_source_revision(&record) as f64 != revision || delivered_text(&record) != expected {
                return Err(plain("This transcript changed while rewriting. Review the current text and try again."));
            }
            let updated = with_rewrite(&record, &rewrite)?;
            if state.storage.contains_history(&id) {
                state.storage.replace_history(&updated)?;
            }
            Ok(remember(&state, updated))
        })
        .handle("history:delete", |state, args| async move {
            let id: String = args.get(0)?;
            state.assert_visible(&id)?;
            state.deletion.assert_no_pending()?;
            let failure = deleted_despite_cleanup(state.storage.delete_history(&id))?;
            state.speech.transcripts.forget(std::slice::from_ref(&id));
            failure.map_or(Ok(()), Err)
        })
        .handle("history:clear", |state, _| async move {
            state.deletion.assert_no_pending()?;
            let failure = deleted_despite_cleanup(state.storage.clear_history())?;
            state.speech.transcripts.clear();
            failure.map_or(Ok(()), Err)
        })
        .handle("history:export", |state: Arc<AppState>, args| async move {
            let id: String = args.get(0)?;
            let format = format_of(&args.get::<String>(1)?);
            state.assert_visible(&id)?;
            let record = state.lookup(&id).ok_or_else(|| plain("Transcript not found"))?;
            let upper = format.as_str().to_uppercase();
            let (title, name) = if format == ExportFormat::Md {
                ("Export Markdown note".to_owned(), "Markdown notes".to_owned())
            } else {
                (format!("Export {upper}"), upper.clone())
            };
            let filter = Filter { name: &name, extensions: &[format.as_str()] };
            let default_name = default_export_name(&record, format);
            let Some(path) = dialogs::save(&state.app, &title, &default_name, filter).await? else { return Ok(None) };
            // Export the text as it is now, not as it was when the picker opened.
            let current = state.lookup_json(&id).filter(|_| !state.deletion.hidden(&id));
            let Some(current) = current else { return Err(plain("Transcript no longer exists")) };
            save_export(&state, &path, &export_record(&current, format)?)?;
            Ok(Some(path.to_string_lossy().into_owned()))
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> TranscriptRecord {
        serde_json::from_value(json!({
            "id": "a", "createdAt": 1, "durationMs": 1, "text": "hello", "model": "r2t2", "language": "en",
            "source": "dictation", "processingTimeMs": 1,
            "magicText": "old", "timings": {"rewritingMs": 5, "speechMs": 7}
        }))
        .unwrap()
    }

    #[test]
    fn clearing_a_rewrite_drops_its_fields_and_timings() {
        let updated = with_rewrite(&record(), &Value::Null).unwrap();
        let value = serde_json::to_value(&updated).unwrap();
        assert_eq!(value["magicText"], Value::Null);
        assert_eq!(value["magicIncludedInferences"], false);
        assert!(value["timings"].get("rewritingMs").is_none());
    }

    #[test]
    fn a_new_rewrite_records_its_source_revision() {
        let rewrite = json!({"text": "new", "preset": "polish", "includedInferences": true, "processingTimeMs": 3,
            "timings": {"rewritingMs": 9}});
        let value = serde_json::to_value(with_rewrite(&record(), &rewrite).unwrap()).unwrap();
        assert_eq!(value["magicText"], "new");
        assert_eq!(value["magicPreset"], "polish");
        assert_eq!(value["rewriteSourceRevision"], 0);
        assert_eq!(value["timings"]["rewritingMs"], 9);
    }
}
