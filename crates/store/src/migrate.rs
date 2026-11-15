//! The one-time move of `history.jsonl` and `vocabulary.json` into the database.
//!
//! Order: parse both files, write rejected lines aside, import everything in ONE
//! transaction, commit, and only then rename the originals to `*.v1.bak`. A kill
//! before the commit leaves the old files untouched and the database without their
//! rows; a kill after it leaves a complete database and maybe an old file that the
//! next start imports again as a no-op (ids already present) before renaming it.
//! The same path imports a file an older app version wrote after a downgrade.
use rusqlite::Connection;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

use crate::{db, HistoryEntry, Vocabulary, HISTORY_FILE, VOCABULARY_FILE};
use crate::{io_error, json_error, write_atomic, StoreError};

/// What one import did; counts only, never text.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Report {
    pub imported: usize,
    /// Entries the database already held exactly: a re-run after a kill, or a line
    /// repeating an earlier one.
    pub already_present: usize,
    /// Imported entries whose id the database held with other content; kept under a
    /// derived id (counted in `imported` too).
    pub rekeyed: usize,
    /// Unparseable lines, kept in `history.jsonl.rejected`.
    pub rejected: usize,
    pub shelves_added: usize,
    /// Terms added to shelves the database already had (same shelf id).
    pub terms_merged: usize,
}

/// Simulated kill for the crash tests: the test harness runs the import in a child
/// process that exits on the spot at the named step.
#[cfg(test)]
fn crash_point(step: &str) {
    if std::env::var("DELULU_TEST_CRASH_AT").as_deref() == Ok(step) {
        std::process::exit(86);
    }
}
#[cfg(not(test))]
fn crash_point(_step: &str) {}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// `<file>.v1.bak`, or `<file>.v1.bak.2`, `.3`… when an earlier backup exists, so a
/// second import (after a downgrade) never overwrites the first backup.
fn backup_path(path: &Path) -> PathBuf {
    let first = suffixed(path, ".v1.bak");
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| suffixed(path, &format!(".v1.bak.{n}")))
        .find(|p| !p.exists())
        .expect("a free backup name")
}

pub(crate) fn history_backups(data_dir: &Path) -> Vec<PathBuf> {
    let prefix = format!("{HISTORY_FILE}.v1.bak");
    let rejected = format!("{HISTORY_FILE}.rejected");
    let Ok(dir) = fs::read_dir(data_dir) else {
        return Vec::new();
    };
    dir.filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix) || n == rejected)
        })
        .collect()
}

fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

struct ParsedHistory {
    /// Valid entries with their 1-based line numbers, in file order.
    entries: Vec<(usize, HistoryEntry)>,
    rejected_lines: Vec<u8>,
    rejected: usize,
}

/// Timings the database can store exactly; anything larger would not round-trip.
fn storable(entry: &HistoryEntry) -> bool {
    let fits = |ms: u64| i64::try_from(ms).is_ok();
    fits(entry.audio_ms)
        && fits(entry.stt_ms)
        && fits(entry.total_ms)
        && entry.cleanup_ms.is_none_or(fits)
}

/// Valid entries in file order; bad lines are counted and collected.
fn parse_history(bytes: &[u8], path: &Path) -> ParsedHistory {
    let mut parsed = ParsedHistory {
        entries: Vec::new(),
        rejected_lines: Vec::new(),
        rejected: 0,
    };
    for (i, line) in bytes.split(|b| *b == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let problem = match serde_json::from_slice::<HistoryEntry>(line) {
            Ok(entry) if storable(&entry) => {
                parsed.entries.push((i + 1, entry));
                continue;
            }
            Ok(_) => "timing out of range".to_string(),
            Err(e) => json_error(&e),
        };
        log::warn!(
            "migration: rejecting history line {} in {}: {problem}",
            i + 1,
            path.display()
        );
        parsed.rejected += 1;
        parsed.rejected_lines.extend_from_slice(line);
        parsed.rejected_lines.push(b'\n');
    }
    parsed
}

enum Placed {
    Imported,
    Rekeyed,
    Present,
}

/// Stores `entry` without losing it or anything already stored. Its id holding the
/// same entry means it is there already; holding another entry, it goes under
/// `<id>~line<n>`, with `~` added until the id is free or holds this same entry, so
/// a re-run lands on the same id and stays a no-op.
fn place(conn: &Connection, mut entry: HistoryEntry, line: usize) -> Result<Placed, StoreError> {
    let original = entry.id.clone();
    loop {
        match db::entry(conn, &entry.id)? {
            None => {
                db::insert_entry(conn, &entry)?;
                return Ok(if entry.id == original {
                    Placed::Imported
                } else {
                    Placed::Rekeyed
                });
            }
            Some(existing) if existing == entry => return Ok(Placed::Present),
            Some(_) if entry.id == original => entry.id = format!("{original}~line{line}"),
            Some(_) => entry.id.push('~'),
        }
    }
}

/// Shelves from the file go after the existing ones. A shelf the database already
/// has (same id) keeps its name and switch and gains the file's terms it lacks.
/// `normalized` then applies the usual limits and drops a new shelf whose name is
/// taken. Returns the merged vocabulary and how many terms joined existing shelves.
fn merge_vocabulary(existing: &Vocabulary, file: Vocabulary) -> (Vocabulary, usize) {
    let mut merged = existing.clone();
    let mut terms_merged = 0;
    for shelf in file.shelves {
        match merged.shelves.iter_mut().find(|s| s.id == shelf.id) {
            Some(known) => {
                for term in shelf.terms {
                    let lower = term.to_lowercase();
                    if !known.terms.iter().any(|t| t.to_lowercase() == lower) {
                        known.terms.push(term);
                        terms_merged += 1;
                    }
                }
            }
            None => merged.shelves.push(shelf),
        }
    }
    (merged.normalized(), terms_merged)
}

/// Removes the lines of a history backup created before `before_ms`, so retention
/// covers the backup too; deletes it once nothing is left. Lines without a readable
/// time are kept.
pub(crate) fn prune_backup(path: &Path, before_ms: i64) -> Result<(), StoreError> {
    filter_backup(path, |entry| entry.created_at < before_ms)
}

/// Removes the lines of a history backup that `deleted` was imported from, so a
/// deleted transcript does not live on in the backup. That is a line with the same
/// content under the same id, or under the id `deleted` was derived from by
/// `place` (`<id>~line<n>`, `~`…).
pub(crate) fn remove_from_backup(path: &Path, deleted: &HistoryEntry) -> Result<(), StoreError> {
    filter_backup(path, |entry| {
        let derived = deleted
            .id
            .strip_prefix(entry.id.as_str())
            .is_some_and(|rest| rest.starts_with('~'));
        (entry.id == deleted.id || derived)
            && HistoryEntry {
                id: deleted.id.clone(),
                ..entry.clone()
            } == *deleted
    })
}

/// Rewrites a history backup without the lines `drop` picks; deletes it once nothing
/// is left. Unparseable lines are kept.
fn filter_backup(path: &Path, drop: impl Fn(&HistoryEntry) -> bool) -> Result<(), StoreError> {
    let bytes = fs::read(path).map_err(|e| io_error(path, e))?;
    let mut kept = Vec::with_capacity(bytes.len());
    for line in bytes.split(|b| *b == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let dropped = serde_json::from_slice::<HistoryEntry>(line).is_ok_and(|entry| drop(&entry));
        if !dropped {
            kept.extend_from_slice(line);
            kept.push(b'\n');
        }
    }
    if kept.is_empty() {
        fs::remove_file(path).map_err(|e| io_error(path, e))
    } else if kept.len() < bytes.len() {
        write_atomic(path, &kept)
    } else {
        Ok(())
    }
}

/// Imports the version 1 files, if any, then renames them to their backups.
pub(crate) fn import_v1(
    conn: &mut Connection,
    config_dir: &Path,
    data_dir: &Path,
) -> Result<Report, StoreError> {
    let history_path = data_dir.join(HISTORY_FILE);
    let vocabulary_path = config_dir.join(VOCABULARY_FILE);

    // An unreadable file is left where it is for the next start; the app runs on.
    let history = read_optional(&history_path).unwrap_or_else(|e| {
        log::error!("migration: cannot read {}: {e}", history_path.display());
        None
    });
    let vocabulary_bytes = read_optional(&vocabulary_path).unwrap_or_else(|e| {
        log::error!("migration: cannot read {}: {e}", vocabulary_path.display());
        None
    });
    if history.is_none() && vocabulary_bytes.is_none() {
        return Ok(Report::default());
    }

    let parsed = parse_history(history.as_deref().unwrap_or_default(), &history_path);
    let mut report = Report {
        rejected: parsed.rejected,
        ..Report::default()
    };
    let vocabulary = match vocabulary_bytes
        .as_deref()
        .map(serde_json::from_slice::<Vocabulary>)
    {
        Some(Ok(vocabulary)) => Some(vocabulary.normalized()),
        Some(Err(e)) => {
            // Same as before the database: an unparseable file is kept aside as .bad.
            log::warn!(
                "migration: {} is unreadable ({}); keeping it as .bad",
                vocabulary_path.display(),
                json_error(&e)
            );
            if let Err(e) = fs::rename(&vocabulary_path, suffixed(&vocabulary_path, ".bad")) {
                log::warn!(
                    "migration: could not move {}: {e}",
                    vocabulary_path.display()
                );
            }
            None
        }
        None => None,
    };
    crash_point("parsed");

    if !parsed.rejected_lines.is_empty() {
        write_atomic(
            &suffixed(&history_path, ".rejected"),
            &parsed.rejected_lines,
        )?;
    }
    crash_point("rejected-written");

    let tx = conn.transaction().map_err(db::sql_error)?;
    let half = parsed.entries.len() / 2;
    for (i, (line, entry)) in parsed.entries.into_iter().enumerate() {
        if i == half {
            crash_point("mid-import");
        }
        match place(&tx, entry, line)? {
            Placed::Imported => report.imported += 1,
            Placed::Rekeyed => {
                report.imported += 1;
                report.rekeyed += 1;
            }
            Placed::Present => report.already_present += 1,
        }
    }
    if let Some(file) = vocabulary {
        let existing = db::load_vocabulary(&tx)?;
        let (merged, terms_merged) = merge_vocabulary(&existing, file);
        if merged.shelves != existing.shelves {
            report.shelves_added = merged.shelves.len().saturating_sub(existing.shelves.len());
            report.terms_merged = terms_merged;
            db::save_vocabulary(&tx, &merged)?;
        }
    }
    crash_point("before-commit");
    tx.commit().map_err(db::sql_error)?;
    crash_point("committed");

    if history.is_some() {
        let backup = backup_path(&history_path);
        fs::rename(&history_path, &backup).map_err(|e| io_error(&history_path, e))?;
    }
    crash_point("history-renamed");
    if vocabulary_path.exists() {
        let backup = backup_path(&vocabulary_path);
        fs::rename(&vocabulary_path, &backup).map_err(|e| io_error(&vocabulary_path, e))?;
    }
    crash_point("vocabulary-renamed");

    let r = &report;
    log::info!(
        "migration: history imported={} already-present={} rekeyed={} rejected={}; shelves added={} terms merged={}",
        r.imported,
        r.already_present,
        r.rekeyed,
        r.rejected,
        r.shelves_added,
        r.terms_merged
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use crate::{Shelf, Store};
    use std::process::Command;

    const CLEANED: &str = r#"{"id":"a1","createdAt":1700000000000,"text":"Één café 🎉, naïve “quotes”","language":"nl","model":"large-v3-turbo-q5_0","audioMs":2100,"sttMs":310,"totalMs":690,"raw":"eh één café","cleanupMs":280,"topic":"everyday"}"#;
    const PLAIN: &str = r#"{"id":"b2","createdAt":1700000005000,"text":"Old line without cleanup fields","language":"en","model":"small","audioMs":900,"sttMs":120,"totalMs":150}"#;
    const REUSED_ID: &str = r#"{"id":"a1","createdAt":1700000009000,"text":"Same id, other words","language":"en","model":"m","audioMs":1,"sttMs":2,"totalMs":3}"#;
    const TORN_LAST: &str = r#"{"id":"c3","createdAt":1700000010000,"text":"Last line, no newline","language":"en","model":"m","audioMs":4,"sttMs":5,"totalMs":6}"#;

    fn history_fixture() -> String {
        // A malformed line, an exact duplicate, a reused id, and no final newline.
        format!("{CLEANED}\n{{\"id\":\"broken\n\n{PLAIN}\nnot json at all\n{CLEANED}\n{REUSED_ID}\n{TORN_LAST}")
    }

    const VOCABULARY: &str = r#"{"version":1,"shelves":[
        {"id":"s-code","name":"Programming","enabled":true,"terms":["T3 Code","Claude Code","Tauri"]},
        {"id":"s-eten","name":"Eten & drinken","enabled":false,"terms":["Stroopwafel","Poffertjes","Crème brûlée"]}
    ]}"#;

    fn write_fixture(t: &TempDir) {
        fs::create_dir_all(t.config()).unwrap();
        fs::create_dir_all(t.data()).unwrap();
        fs::write(t.data().join(HISTORY_FILE), history_fixture()).unwrap();
        fs::write(t.config().join(VOCABULARY_FILE), VOCABULARY).unwrap();
    }

    /// Every valid entry, newest first, with the reused id kept under its line number.
    fn expected_history() -> Vec<HistoryEntry> {
        let parse = |line: &str| serde_json::from_str::<HistoryEntry>(line).unwrap();
        let mut reused = parse(REUSED_ID);
        reused.id = "a1~line7".into();
        vec![parse(TORN_LAST), reused, parse(PLAIN), parse(CLEANED)]
    }

    fn expected_shelves() -> Vec<Shelf> {
        serde_json::from_str::<Vocabulary>(VOCABULARY)
            .unwrap()
            .shelves
    }

    fn assert_migrated(t: &TempDir) {
        let store = Store::open(&t.config(), &t.data()).unwrap();
        assert_eq!(store.history(None, usize::MAX), expected_history());
        assert_eq!(store.vocabulary().shelves, expected_shelves());
        drop(store);
        assert!(!t.data().join(HISTORY_FILE).exists());
        assert!(!t.config().join(VOCABULARY_FILE).exists());
        assert_eq!(
            fs::read_to_string(t.data().join("history.jsonl.v1.bak")).unwrap(),
            history_fixture()
        );
        assert_eq!(
            fs::read_to_string(t.config().join("vocabulary.json.v1.bak")).unwrap(),
            VOCABULARY
        );
        assert!(!t.data().join("history.jsonl.v1.bak.2").exists());
        assert_eq!(
            fs::read_to_string(t.data().join("history.jsonl.rejected")).unwrap(),
            "{\"id\":\"broken\nnot json at all\n"
        );
    }

    #[test]
    fn migration_keeps_every_valid_entry_and_field() {
        let t = TempDir::new();
        write_fixture(&t);
        let mut conn = db::open(&t.data().join(db::DB_FILE)).unwrap();
        let report = import_v1(&mut conn, &t.config(), &t.data()).unwrap();
        assert_eq!(
            report,
            Report {
                imported: 4,
                already_present: 1,
                rekeyed: 1,
                rejected: 2,
                shelves_added: 2,
                terms_merged: 0,
            }
        );
        drop(conn);
        assert_migrated(&t);
        // Searchable straight after the import.
        let store = Store::open(&t.config(), &t.data()).unwrap();
        assert_eq!(store.history(Some("cafe"), 10)[0].id, "a1");
    }

    #[test]
    fn running_the_import_again_is_a_no_op() {
        let t = TempDir::new();
        write_fixture(&t);
        drop(Store::open(&t.config(), &t.data()).unwrap());
        // Nothing left to import.
        let mut conn = db::open(&t.data().join(db::DB_FILE)).unwrap();
        assert_eq!(
            import_v1(&mut conn, &t.config(), &t.data()).unwrap(),
            Report::default()
        );
        // The same files again (an un-renamed original) add nothing.
        write_fixture(&t);
        let report = import_v1(&mut conn, &t.config(), &t.data()).unwrap();
        assert_eq!((report.imported, report.already_present), (0, 5));
        assert_eq!(report.shelves_added, 0);
        drop(conn);
        let store = Store::open(&t.config(), &t.data()).unwrap();
        assert_eq!(store.history(None, usize::MAX), expected_history());
        assert_eq!(store.vocabulary().shelves, expected_shelves());
        // The first backup is never overwritten.
        assert!(t.data().join("history.jsonl.v1.bak.2").exists());
    }

    #[test]
    fn files_written_after_a_downgrade_are_merged() {
        let t = TempDir::new();
        write_fixture(&t);
        drop(Store::open(&t.config(), &t.data()).unwrap());
        // An older version wrote fresh files: one entry it already had, a new one,
        // and a known id with other content.
        let changed = PLAIN.replace(r#""totalMs":150"#, r#""totalMs":999"#);
        fs::write(
            t.data().join(HISTORY_FILE),
            format!("{TORN_LAST}\n{}\n{changed}\n", PLAIN.replace("b2", "d4")),
        )
        .unwrap();
        fs::write(
            t.config().join(VOCABULARY_FILE),
            r#"{"shelves":[
                {"id":"s-code","name":"Code","enabled":false,"terms":["tauri","Rust"]},
                {"id":"s-new","name":"Games","terms":["Elden Ring"]}
            ]}"#,
        )
        .unwrap();
        let store = Store::open(&t.config(), &t.data()).unwrap();
        let entries = store.history(None, 100);
        let ids: Vec<_> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["c3", "a1~line7", "b2~line3", "d4", "b2", "a1"]);
        assert_eq!((entries[2].total_ms, entries[4].total_ms), (999, 150));
        let shelves = store.vocabulary().shelves;
        let names: Vec<_> = shelves.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Programming", "Eten & drinken", "Games"]);
        assert_eq!(
            shelves[0].terms,
            ["T3 Code", "Claude Code", "Tauri", "Rust"]
        );
        assert!(shelves[0].enabled);
        assert!(t.config().join("vocabulary.json.v1.bak.2").exists());
    }

    #[test]
    fn deleting_an_imported_entry_removes_it_from_the_backup() {
        let t = TempDir::new();
        write_fixture(&t);
        let store = Store::open(&t.config(), &t.data()).unwrap();
        let backup = t.data().join("history.jsonl.v1.bak");
        // The rekeyed entry goes, but not the other entry under its original id.
        store.delete_history("a1~line7").unwrap();
        store.delete_history("b2").unwrap();
        let kept = fs::read_to_string(&backup).unwrap();
        assert!(!kept.contains("Same id, other words"), "{kept}");
        assert!(!kept.contains("Old line without cleanup fields"), "{kept}");
        assert_eq!(kept.matches("Één café").count(), 2, "{kept}");
        assert!(kept.contains("Last line, no newline") && kept.contains("not json at all"));
        // The last entries go with the backup lines that held them.
        store.delete_history("a1").unwrap();
        store.delete_history("c3").unwrap();
        assert_eq!(
            fs::read_to_string(&backup).unwrap(),
            "{\"id\":\"broken\nnot json at all\n"
        );
    }

    #[test]
    fn a_derived_id_never_overwrites_a_real_one() {
        let t = TempDir::new();
        fs::create_dir_all(t.data()).unwrap();
        let line = |id: &str, text: &str| {
            format!(
                r#"{{"id":"{id}","createdAt":1,"text":"{text}","language":"en","model":"m","audioMs":1,"sttMs":1,"totalMs":1}}"#
            )
        };
        let file = format!(
            "{}\n{}\n{}\n",
            line("a", "first"),
            line("a~line3", "literal"),
            line("a", "third")
        );
        fs::write(t.data().join(HISTORY_FILE), &file).unwrap();
        let mut conn = db::open(&t.data().join(db::DB_FILE)).unwrap();
        import_v1(&mut conn, &t.config(), &t.data()).unwrap();
        let text = |id: &str| db::entry(&conn, id).unwrap().map(|e| e.text);
        assert_eq!(text("a~line3").as_deref(), Some("literal"));
        assert_eq!(text("a~line3~").as_deref(), Some("third"));

        fs::write(t.data().join(HISTORY_FILE), &file).unwrap();
        let again = import_v1(&mut conn, &t.config(), &t.data()).unwrap();
        assert_eq!((again.imported, again.already_present), (0, 3));
    }

    /// Runs in a child process: opens the store with a crash point armed.
    #[test]
    #[ignore = "run by kill_at_any_step_recovers in a child process"]
    fn crash_child() {
        let Ok(dir) = std::env::var("DELULU_TEST_DIR") else {
            return;
        };
        let dir = PathBuf::from(dir);
        let _ = Store::open(&dir.join("config"), &dir.join("data"));
    }

    #[test]
    fn kill_at_any_step_recovers() {
        let steps = [
            ("parsed", false),
            ("rejected-written", false),
            ("mid-import", false),
            ("before-commit", false),
            ("committed", true),
            ("history-renamed", true),
            ("vocabulary-renamed", true),
        ];
        for (step, committed) in steps {
            let t = TempDir::new();
            write_fixture(&t);
            let status = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "migrate::tests::crash_child",
                    "--test-threads=1",
                    "--quiet",
                ])
                .env("DELULU_TEST_DIR", &t.0)
                .env("DELULU_TEST_CRASH_AT", step)
                .output()
                .unwrap()
                .status;
            assert_eq!(status.code(), Some(86), "the child did not stop at {step}");
            if !committed {
                // Killed before the commit: the old files are untouched and usable.
                assert_eq!(
                    fs::read_to_string(t.data().join(HISTORY_FILE)).unwrap(),
                    history_fixture(),
                    "{step}"
                );
                let conn = db::open(&t.data().join(db::DB_FILE)).unwrap();
                assert!(db::search(&conn, None, 10).unwrap().is_empty(), "{step}");
            }
            assert_migrated(&t);
        }
    }
}
