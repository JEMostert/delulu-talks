#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteKey {
    ShiftInsert,
    CtrlV,
    CtrlShiftV,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertOutcome {
    Pasted,
    CopiedOnly { reason: String },
}
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertStatus {
    pub ready: bool,
    pub error: Option<String>,
}
#[derive(Debug, thiserror::Error)]
pub enum InsertError {
    #[error("clipboard: {0}")]
    Clipboard(String),
}
