//! The SQLite database in the data folder: history with a full-text index, and the
//! vocabulary shelves.
//!
//! Removal is real: `secure_delete` zeroes freed content, a removal merges the
//! full-text index so no segment keeps the old tokens, and a `TRUNCATE` checkpoint
//! empties the write-ahead log, so a deleted transcript is gone from the file bytes.
use rusqlite::{params, Connection, ErrorCode, OptionalExtension, Row, Transaction};
use std::{fs, path::Path, time::Duration};

use crate::{HistoryEntry, Shelf, StoreError, Vocabulary};

pub(crate) const DB_FILE: &str = "delulu.db";

/// Bumped with every schema change; each step from the previous version is applied
/// in one transaction.
const SCHEMA_VERSION: i64 = 1;

const SCHEMA_V1: &str = r#"
CREATE TABLE history (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    text TEXT NOT NULL,
    raw TEXT,
    language TEXT NOT NULL,
    model TEXT NOT NULL,
    topic TEXT,
    audio_ms INTEGER NOT NULL,
    stt_ms INTEGER NOT NULL,
    total_ms INTEGER NOT NULL,
    cleanup_ms INTEGER
);
CREATE INDEX history_by_time ON history (created_at, seq);

-- Trigrams match any part of a word, like the substring search before it, which
-- matters for Dutch compounds; case and diacritics are ignored.
CREATE VIRTUAL TABLE history_fts USING fts5 (
    text,
    content = 'history',
    content_rowid = 'seq',
    tokenize = 'trigram remove_diacritics 1'
);
CREATE TRIGGER history_fts_insert AFTER INSERT ON history BEGIN
    INSERT INTO history_fts (rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER history_fts_delete AFTER DELETE ON history BEGIN
    INSERT INTO history_fts (history_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER history_fts_update AFTER UPDATE OF text ON history BEGIN
    INSERT INTO history_fts (history_fts, rowid, text) VALUES ('delete', old.seq, old.text);
    INSERT INTO history_fts (rowid, text) VALUES (new.seq, new.text);
END;

CREATE TABLE shelf (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL
);
CREATE TABLE shelf_term (
    shelf_id TEXT NOT NULL REFERENCES shelf (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    term TEXT NOT NULL,
    PRIMARY KEY (shelf_id, position)
) WITHOUT ROWID;
"#;

const ENTRY_COLUMNS: &str = "id, created_at, text, raw, language, model, topic, \
     audio_ms, stt_ms, total_ms, cleanup_ms";

pub(crate) fn sql_error(e: rusqlite::Error) -> StoreError {
    StoreError::Io(format!("database: {e}"))
}

/// Why the database could not be opened.
#[derive(Debug)]
pub(crate) enum OpenError {
    /// The file is there but is not a usable database: it can only be moved aside.
    Damaged(String),
    /// Anything else, such as no space, no permission or a schema from a newer
    /// version: the file is left alone.
    Unavailable(String),
}

fn open_error(e: rusqlite::Error) -> OpenError {
    let message = format!("database: {e}");
    match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => OpenError::Damaged(message),
        _ => OpenError::Unavailable(message),
    }
}

/// Opens (or creates) the database and brings its schema up to date.
pub(crate) fn open(path: &Path) -> Result<Connection, OpenError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| OpenError::Unavailable(format!("{}: {e}", dir.display())))?;
    }
    let mut conn = Connection::open(path).map_err(open_error)?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(open_error)?;
    let mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(open_error)?;
    if !mode.eq_ignore_ascii_case("wal") {
        log::warn!("database: journal mode is {mode}, not WAL");
    }
    // FULL: a dictation that was reported saved survives a power cut, as the
    // fsynced append to history.jsonl did.
    conn.execute_batch(
        "PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;",
    )
    .map_err(open_error)?;
    // Reads the schema, so a damaged one shows now rather than at the first save.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(open_error)?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(open_error)?;
    if version > SCHEMA_VERSION {
        return Err(OpenError::Unavailable(format!(
            "{} was made by a newer version of Delulu Talks (schema {version})",
            path.display()
        )));
    }
    if version < 1 {
        let tx = conn.transaction().map_err(open_error)?;
        tx.execute_batch(SCHEMA_V1).map_err(open_error)?;
        tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
            .map_err(open_error)?;
        tx.commit().map_err(open_error)?;
    }
    // Finishes a scrub that an outside reader kept from emptying the log last time.
    checkpoint(&conn).map_err(|e| OpenError::Unavailable(e.to_string()))?;
    Ok(conn)
}

fn to_sql_ms(ms: u64) -> i64 {
    i64::try_from(ms).unwrap_or(i64::MAX)
}

fn entry_from_row(row: &Row<'_>) -> rusqlite::Result<HistoryEntry> {
    let ms = |i: usize| row.get::<_, i64>(i).map(|v| v.max(0) as u64);
    Ok(HistoryEntry {
        id: row.get(0)?,
        created_at: row.get(1)?,
        text: row.get(2)?,
        raw: row.get(3)?,
        language: row.get(4)?,
        model: row.get(5)?,
        topic: row.get(6)?,
        audio_ms: ms(7)?,
        stt_ms: ms(8)?,
        total_ms: ms(9)?,
        cleanup_ms: row.get::<_, Option<i64>>(10)?.map(|v| v.max(0) as u64),
    })
}

/// Inserts `entry` unless its id is already there. Returns whether it was inserted.
pub(crate) fn insert_entry(conn: &Connection, entry: &HistoryEntry) -> Result<bool, StoreError> {
    let changed = conn
        .prepare_cached(&format!(
            "INSERT OR IGNORE INTO history ({ENTRY_COLUMNS}) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
        ))
        .and_then(|mut statement| {
            statement.execute(params![
                entry.id,
                entry.created_at,
                entry.text,
                entry.raw,
                entry.language,
                entry.model,
                entry.topic,
                to_sql_ms(entry.audio_ms),
                to_sql_ms(entry.stt_ms),
                to_sql_ms(entry.total_ms),
                entry.cleanup_ms.map(to_sql_ms),
            ])
        })
        .map_err(sql_error)?;
    Ok(changed == 1)
}

pub(crate) fn entry(conn: &Connection, id: &str) -> Result<Option<HistoryEntry>, StoreError> {
    conn.query_row(
        &format!("SELECT {ENTRY_COLUMNS} FROM history WHERE id = ?1"),
        [id],
        entry_from_row,
    )
    .optional()
    .map_err(sql_error)
}

pub(crate) fn set_total_ms(
    conn: &Connection,
    id: &str,
    total_ms: u64,
) -> Result<Option<HistoryEntry>, StoreError> {
    let changed = conn
        .execute(
            "UPDATE history SET total_ms = ?1 WHERE id = ?2",
            params![to_sql_ms(total_ms), id],
        )
        .map_err(sql_error)?;
    if changed == 0 {
        return Ok(None);
    }
    entry(conn, id)
}

/// The words of a search, split into ones the trigram index can match (three or
/// more characters) and shorter ones, which are matched on the candidates.
fn search_words(query: &str) -> (Vec<String>, Vec<String>) {
    query
        .split_whitespace()
        .map(str::to_string)
        .partition(|word| word.chars().count() >= 3)
}

/// An FTS5 query that needs every word somewhere in the text, each as a quoted string
/// so operators and punctuation in what the user typed are taken literally.
fn match_expression(words: &[String]) -> String {
    words
        .iter()
        .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// Newest first. Every word of `query` must occur in the text, anywhere in a word,
/// ignoring case; words of three or more characters also ignore diacritics.
pub(crate) fn search(
    conn: &Connection,
    query: Option<&str>,
    limit: usize,
) -> Result<Vec<HistoryEntry>, StoreError> {
    let (indexed, short) = search_words(query.unwrap_or(""));
    // Short words filter afterwards, so the limit can only apply in SQL without them.
    let sql_limit = if short.is_empty() {
        i64::try_from(limit).unwrap_or(i64::MAX)
    } else {
        -1
    };
    let order = "ORDER BY created_at DESC, seq DESC LIMIT ?";
    let rows = if indexed.is_empty() {
        let mut statement = conn
            .prepare_cached(&format!("SELECT {ENTRY_COLUMNS} FROM history {order}"))
            .map_err(sql_error)?;
        let rows = statement
            .query_map([sql_limit], entry_from_row)
            .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>);
        rows.map_err(sql_error)?
    } else {
        let mut statement = conn
            .prepare_cached(&format!(
                "SELECT {ENTRY_COLUMNS} FROM history WHERE seq IN \
                 (SELECT rowid FROM history_fts WHERE history_fts MATCH ?) {order}"
            ))
            .map_err(sql_error)?;
        let rows = statement
            .query_map(
                params![match_expression(&indexed), sql_limit],
                entry_from_row,
            )
            .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>);
        rows.map_err(sql_error)?
    };
    if short.is_empty() {
        return Ok(rows);
    }
    let short: Vec<String> = short.iter().map(|w| w.to_lowercase()).collect();
    Ok(rows
        .into_iter()
        .filter(|entry| {
            let text = entry.text.to_lowercase();
            short.iter().all(|word| text.contains(word.as_str()))
        })
        .take(limit)
        .collect())
}

/// Merges the full-text index so no old segment still holds the removed tokens,
/// then empties the write-ahead log, which can hold earlier copies of the pages.
fn scrub(conn: &Connection) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO history_fts (history_fts) VALUES ('optimize')",
        [],
    )
    .map_err(sql_error)?;
    checkpoint(conn)
}

fn checkpoint(conn: &Connection) -> Result<(), StoreError> {
    let busy: i64 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .map_err(sql_error)?;
    if busy != 0 {
        log::warn!("database: the write-ahead log could not be emptied yet");
    }
    Ok(())
}

pub(crate) fn delete_entry(conn: &Connection, id: &str) -> Result<(), StoreError> {
    let removed = conn
        .execute("DELETE FROM history WHERE id = ?1", [id])
        .map_err(sql_error)?;
    if removed > 0 {
        scrub(conn)?;
    }
    Ok(())
}

/// Removes every entry, rebuilds the file without the freed pages and empties the log.
pub(crate) fn clear(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "DELETE FROM history; INSERT INTO history_fts (history_fts) VALUES ('delete-all'); VACUUM;",
    )
    .map_err(sql_error)?;
    checkpoint(conn)
}

/// Removes entries created before `before_ms`. Returns how many.
pub(crate) fn prune(conn: &Connection, before_ms: i64) -> Result<usize, StoreError> {
    let removed = conn
        .execute("DELETE FROM history WHERE created_at < ?1", [before_ms])
        .map_err(sql_error)?;
    if removed > 0 {
        scrub(conn)?;
    }
    Ok(removed)
}

pub(crate) fn load_vocabulary(conn: &Connection) -> Result<Vocabulary, StoreError> {
    let load = || -> rusqlite::Result<Vocabulary> {
        let mut shelves: Vec<Shelf> = conn
            .prepare("SELECT id, name, enabled FROM shelf ORDER BY position")?
            .query_map([], |row| {
                Ok(Shelf {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    enabled: row.get(2)?,
                    terms: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut statement =
            conn.prepare("SELECT term FROM shelf_term WHERE shelf_id = ?1 ORDER BY position")?;
        for shelf in &mut shelves {
            shelf.terms = statement
                .query_map([&shelf.id], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
        }
        Ok(Vocabulary {
            shelves,
            ..Vocabulary::default()
        })
    };
    load().map_err(sql_error)
}

/// Replaces every shelf and term with `vocabulary`, inside the caller's transaction.
pub(crate) fn save_vocabulary(
    tx: &Transaction<'_>,
    vocabulary: &Vocabulary,
) -> Result<(), StoreError> {
    let save = || -> rusqlite::Result<()> {
        tx.execute_batch("DELETE FROM shelf_term; DELETE FROM shelf;")?;
        let mut add_shelf =
            tx.prepare("INSERT INTO shelf (id, position, name, enabled) VALUES (?1, ?2, ?3, ?4)")?;
        let mut add_term =
            tx.prepare("INSERT INTO shelf_term (shelf_id, position, term) VALUES (?1, ?2, ?3)")?;
        for (position, shelf) in vocabulary.shelves.iter().enumerate() {
            add_shelf.execute(params![
                shelf.id,
                position as i64,
                shelf.name,
                shelf.enabled
            ])?;
            for (at, term) in shelf.terms.iter().enumerate() {
                add_term.execute(params![shelf.id, at as i64, term])?;
            }
        }
        Ok(())
    };
    save().map_err(sql_error)
}
