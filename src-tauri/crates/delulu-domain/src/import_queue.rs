//! Audio import queue contracts (`src/importQueue.ts`).

use serde::{Deserialize, Serialize};

use crate::serde_js;

string_enum! {
    pub enum ImportJobState {
        Queued = "queued",
        Running = "running",
        Cancelling = "cancelling",
        Completed = "completed",
        Failed = "failed",
        Cancelled = "cancelled",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportQueueJob {
    pub id: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "serde_js::opt_f64")]
    pub source_mtime_ms: Option<f64>,
    pub state: ImportJobState,
    pub error: Option<String>,
    pub transcript_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportQueueSnapshot {
    pub version: u64,
    pub paused: bool,
    pub jobs: Vec<ImportQueueJob>,
}

pub const IMPORT_QUEUE_LIMIT: usize = 50;

pub fn empty_import_queue() -> ImportQueueSnapshot {
    ImportQueueSnapshot { version: 0, paused: true, jobs: Vec::new() }
}

impl Default for ImportQueueSnapshot {
    fn default() -> Self {
        empty_import_queue()
    }
}
