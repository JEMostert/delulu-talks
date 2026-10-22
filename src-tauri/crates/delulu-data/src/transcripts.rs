//! Transcript exports (`transcripts.ts` and the export formatting in
//! `ipc/history.ts`).
//!
//! Records are taken as persisted JSON so JSON exports keep the saved key
//! order and unknown keys exactly like the Electron app's exports.

use std::fs;
use std::io::Write;
use std::path::Path;

use delulu_core::util::create_private;
use delulu_core::{uuid, DomainResult};
use delulu_domain::text::{delivered_text, transcript_text};
use delulu_domain::{ExportFormat, TranscriptRecord};
use serde_json::{json, Value};

use crate::storage::record_from_value;
use crate::{json as js, plain_error, time};

fn markdown_block(text: &str, language: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for ch in text.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(3.max(longest + 1));
    let newline = if text.ends_with('\n') { "" } else { "\n" };
    format!("{fence}{language}\n{text}{newline}{fence}\n")
}

fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

fn markdown_note(value: &Value, record: &TranscriptRecord) -> String {
    let metadata = json!({
        "id": record.id,
        "recordedAt": time::iso_string(record.created_at),
        "speechModel": value.get("model"),
        "language": value.get("language"),
        "source": value.get("source"),
        "sourceName": or_null(value.get("sourceName")),
        "rewriteModel": or_null(value.get("magicModel")),
    });
    let mut sections: Vec<(&str, &str)> = vec![("Original speech", &record.text)];
    if let Some(Some(edited)) = &record.edited_text {
        sections.push(("Saved correction", edited));
    }
    if let Some(Some(personalized)) = &record.personalized_text {
        sections.push(("Vocabulary result", personalized));
    }
    if let Some(Some(magic)) = &record.magic_text {
        sections.push(("Rewrite", magic));
    }
    let mut note = format!("# Transcript note\n\n## Recording\n\n{}\n", markdown_block(&js::stringify_pretty(&metadata), "json"));
    for (title, text) in sections {
        note.push_str(&format!("## {title}\n\n{}\n", markdown_block(text, "text")));
    }
    note
}

fn typed(value: &Value) -> DomainResult<TranscriptRecord> {
    record_from_value(value).ok_or_else(|| plain_error("Transcript not found"))
}

/// One transcript as TXT (delivered text, plus the source when it differs),
/// JSON (the saved record) or a Markdown note.
pub fn export_record(value: &Value, format: ExportFormat) -> DomainResult<String> {
    if format == ExportFormat::Json {
        return Ok(js::profile_bytes(value));
    }
    let record = typed(value)?;
    if format == ExportFormat::Md {
        return Ok(markdown_note(value, &record));
    }
    let source = transcript_text(&record);
    let output = delivered_text(&record);
    let rewritten = matches!(&record.magic_text, Some(Some(text)) if !text.is_empty());
    let personalized = matches!(&record.personalized_text, Some(Some(text)) if !text.is_empty());
    Ok(if rewritten || (personalized && output != source) {
        format!("{output}\n\n--- Source transcript ---\n\n{}\n", delulu_domain::js::trim(source))
    } else {
        format!("{output}\n")
    })
}

/// `history:exportSelection` content: TXT with a header per transcript, or a JSON array.
pub fn export_selection(records: &[Value], format: ExportFormat) -> DomainResult<String> {
    match format {
        ExportFormat::Json => Ok(js::profile_bytes(&Value::Array(records.to_vec()))),
        ExportFormat::Txt => {
            let mut parts = Vec::with_capacity(records.len());
            for (index, value) in records.iter().enumerate() {
                let record = typed(value)?;
                let created = time::iso_string(record.created_at).ok_or_else(|| plain_error("Invalid time value"))?;
                parts.push(format!(
                    "=== Transcript {} of {} · {created} · {} ===\n{}",
                    index + 1,
                    records.len(),
                    record.id,
                    export_record(value, ExportFormat::Txt)?
                ));
            }
            Ok(parts.join("\n"))
        }
        ExportFormat::Md => Err(plain_error("Choose TXT or JSON export.")),
    }
}

/// The default export file name (`history:export`).
pub fn default_export_name(record: &TranscriptRecord, format: ExportFormat) -> String {
    let base = match &record.source_name {
        Some(Some(name)) => name.clone(),
        _ => format!("delulu-{}", js::format_number(record.created_at)),
    };
    let stem = match base.rfind('.') {
        Some(dot) if !base[dot + 1..].is_empty() && !base[dot + 1..].contains('.') => &base[..dot],
        _ => base.as_str(),
    };
    format!("{stem}.{format}")
}

/// Replace only a fully written export outside the application profile. A
/// failed write leaves the destination intact, and renaming a fresh file never
/// writes through a final-component hard or symbolic link.
pub fn write_export_file(data_directory: &Path, output_path: &Path, text: &str) -> DomainResult<()> {
    let parent = output_path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let parent = fs::canonicalize(parent)?;
    let name = output_path.file_name().ok_or_else(|| plain_error("Choose a file name for the export."))?;
    let destination = parent.join(name);
    if destination.starts_with(fs::canonicalize(data_directory)?) {
        return Err(plain_error("Export outside Delulu's data directory to preserve history, settings and runtimes."));
    }
    let temporary = parent.join(format!(".{}.{}.tmp", name.to_string_lossy(), uuid()));
    let result = (|| -> std::io::Result<()> {
        let mut file = create_private(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &destination)
    })();
    // Best-effort cleanup must not hide the original save failure.
    let _ = fs::remove_file(&temporary);
    Ok(result?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Value {
        json!({"id": "r1", "createdAt": 1_700_000_000_000u64, "durationMs": 1, "text": " Original ", "model": "r2t2",
            "language": "en", "source": "file", "sourceName": "memo.m4a", "processingTimeMs": 1,
            "magicText": "Rewrite with ``` fence", "magicModel": "qwen35Small"})
    }

    #[test]
    fn exports_match_the_typescript_layout() {
        assert_eq!(
            export_record(&record(), ExportFormat::Txt).unwrap(),
            "Rewrite with ``` fence\n\n--- Source transcript ---\n\nOriginal\n"
        );
        let note = export_record(&record(), ExportFormat::Md).unwrap();
        assert!(note.starts_with("# Transcript note\n\n## Recording\n\n```json\n{\n  \"id\": \"r1\",\n  \"recordedAt\": \"2023-11-14T22:13:20.000Z\""));
        assert!(note.contains("## Rewrite\n\n````text\nRewrite with ``` fence\n````\n\n"));
        assert_eq!(export_record(&record(), ExportFormat::Json).unwrap(), format!("{}\n", js::stringify_pretty(&record())));
        let txt = export_selection(&[record()], ExportFormat::Txt).unwrap();
        assert!(txt.starts_with("=== Transcript 1 of 1 · 2023-11-14T22:13:20.000Z · r1 ===\nRewrite"));
        assert_eq!(default_export_name(&record_from_value(&record()).unwrap(), ExportFormat::Md), "memo.md");
    }

    #[test]
    fn exports_refuse_the_data_directory() {
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        assert!(write_export_file(data.path(), &data.path().join("x.txt"), "x").is_err());
        let target = outside.path().join("x.txt");
        write_export_file(data.path(), &target, "hello").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "hello");
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }
}
