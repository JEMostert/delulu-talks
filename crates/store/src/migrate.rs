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
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
};

use crate::{db, HistoryEntry, Vocabulary, HISTORY_FILE, VOCABULARY_FILE};
use crate::{io_error, json_error, write_atomic, StoreError};

/// What one import did; counts only, never text.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Report {
    pub imported: usize,
    /// Ids the database already had (a re-run after a kill).
    pub already_present: usize,
    /// Lines repeating an earlier line exactly.
    pub duplicates: usize,
    /// Lines reusing an earlier line's id with different content; kept under a new id.
    pub rekeyed: usize,
    /// Unparseable lines, kept in `history.jsonl.rejected`.
    pub rejected: usize,
    pub shelves_added: usize,
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
    entries: Vec<HistoryEntry>,
    rejected_lines: Vec<u8>,
    report: Report,
}

/// Valid entries in file order. Bad lines are counted and collected; an exact repeat
/// is dropped; a reused id with other content gets a new id derived from the line
/// number, so a re-run assigns the same one and stays a no-op.
fn parse_history(bytes: &[u8], path: &Path) -> ParsedHistory {
    let mut parsed = ParsedHistory {
        entries: Vec::new(),
        rejected_lines: Vec::new(),
        report: Report::default(),
    };
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (i, line) in bytes.split(|b| *b == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let mut entry = match serde_json::from_slice::<HistoryEntry>(line) {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!(
                    "migration: rejecting history line {} in {}: {}",
                    i + 1,
                    path.display(),
                    json_error(&e)
                );
                parsed.report.rejected += 1;
                parsed.rejected_lines.extend_from_slice(line);
                parsed.rejected_lines.push(b'\n');
                continue;
            }
        };
        if let Some(&at) = seen.get(&entry.id) {
            if parsed.entries[at] == entry {
                parsed.report.duplicates += 1;
                continue;
            }
            entry.id = format!("{}~line{}", entry.id, i + 1);
            parsed.report.rekeyed += 1;
        }
        seen.insert(entry.id.clone(), parsed.entries.len());
        parsed.entries.push(entry);
    }
    parsed
}

/// Shelves from the file whose ids the database lacks go after the existing ones.
/// `normalized` then applies the usual limits and drops a shelf whose name is taken.
fn merge_vocabulary(existing: &Vocabulary, file: Vocabulary) -> Vocabulary {
    let mut merged = existing.clone();
    merged.shelves.extend(
        file.shelves
            .into_iter()
            .filter(|shelf| !existing.shelves.iter().any(|s| s.id == shelf.id)),
    );
    merged.normalized()
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

    let mut parsed = match &history {
        Some(bytes) => parse_history(bytes, &history_path),
        None => parse_history(b"", &history_path),
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
    for (i, entry) in parsed.entries.iter().enumerate() {
        if i == half {
            crash_point("mid-import");
        }
        if db::insert_entry(&tx, entry)? {
            parsed.report.imported += 1;
        } else {
            parsed.report.already_present += 1;
        }
    }
    if let Some(file) = vocabulary {
        let existing = db::load_vocabulary(&tx)?;
        let merged = merge_vocabulary(&existing, file);
        if merged.shelves != existing.shelves {
            parsed.report.shelves_added = merged.shelves.len() - existing.shelves.len();
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

    let r = &parsed.report;
    log::info!(
        "migration: history imported={} already-present={} duplicates={} rekeyed={} rejected={}; shelves added={}",
        r.imported,
        r.already_present,
        r.duplicates,
        r.rekeyed,
        r.rejected,
        r.shelves_added
    );
    Ok(parsed.report)
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
                already_present: 0,
                duplicates: 1,
                rekeyed: 1,
                rejected: 2,
                shelves_added: 2,
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
        assert_eq!((report.imported, report.already_present), (0, 4));
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
        // An older version starts empty and writes fresh files.
        fs::write(
            t.data().join(HISTORY_FILE),
            format!("{TORN_LAST}\n{}\n", PLAIN.replace("b2", "d4")),
        )
        .unwrap();
        fs::write(
            t.config().join(VOCABULARY_FILE),
            r#"{"shelves":[{"id":"s-new","name":"Games","terms":["Elden Ring"]},{"id":"s-dup","name":"programming","terms":["x"]}]}"#,
        )
        .unwrap();
        let store = Store::open(&t.config(), &t.data()).unwrap();
        let ids: Vec<_> = store.history(None, 100).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, ["c3", "a1~line7", "d4", "b2", "a1"]);
        let names: Vec<_> = store
            .vocabulary()
            .shelves
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, ["Programming", "Eten & drinken", "Games"]);
        assert!(t.config().join("vocabulary.json.v1.bak.2").exists());
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
