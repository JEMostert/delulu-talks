//! TypeScript declarations for the client API, generated from the Rust types.
//!
//! The output is committed as `ui/src/generated/proto.ts`. The test
//! `generated_typescript_is_current` (in `tests/generated.rs`) fails when the file is
//! stale; run `UPDATE_GENERATED=1 cargo test -p delulu-proto --test generated` to
//! rewrite it.

use crate::api::*;
use crate::state::*;
use ts_rs::{Config, TS};

/// Path of the generated file, relative to the repository root.
pub const OUTPUT: &str = "ui/src/generated/proto.ts";

pub fn typescript() -> String {
    // u64 fields hold milliseconds, bytes and ids, all far below 2^53.
    let cfg = Config::new().with_large_int("number");
    let mut out = String::from(
        "// Generated from crates/proto by `UPDATE_GENERATED=1 cargo test -p delulu-proto --test generated`.\n\
         // Do not edit by hand.\n\n",
    );
    out.push_str(&format!(
        "export const PROTOCOL_VERSION = {};\n\n",
        crate::PROTOCOL_VERSION
    ));
    macro_rules! declare {
        ($($t:ty),* $(,)?) => {$(
            if let Some(docs) = <$t as TS>::docs() {
                out.push_str(&docs);
            }
            out.push_str("export ");
            out.push_str(&<$t as TS>::decl(&cfg));
            out.push_str("\n\n");
        )*};
    }
    declare!(
        // state
        AppState,
        DaemonInfo,
        DaemonMode,
        DictationPhase,
        DictationState,
        DictationOutcome,
        Delivery,
        WorkerStatus,
        WorkerState,
        HotkeyState,
        InsertState,
        Settings,
        InsertMode,
        Theme,
        RoleModels,
        HistoryPage,
        HistoryEntry,
        Vocabulary,
        Shelf,
        Preset,
        ModelsState,
        ModelRole,
        ModelInfo,
        ModelState,
        Download,
        DownloadState,
        GpuInfo,
        RadioState,
        RadioKind,
        RadioItem,
        RadioMaking,
        RadioStep,
        RadioRequest,
        RadioDirection,
        RadioReadiness,
        VoiceState,
        Conversation,
        ConversationPhase,
        Turn,
        Speaker,
        AgentReport,
        // api
        HelloParams,
        HelloResult,
        GetStateParams,
        SubscribeParams,
        UnsubscribeParams,
        Subscribed,
        ToggleParams,
        CancelParams,
        DictationReply,
        Topic,
        Event,
        ErrorCode,
        ApiError,
        RequestMessage,
        ResultMessage,
        ErrorMessage,
        EventMessage,
        ServerMessage,
    );
    out.push_str(&ts_methods(&cfg));
    out
}
