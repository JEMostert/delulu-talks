pub const APP_ID: &str = "com.joran.delulu-talks";
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
pub struct Inserter;
impl Inserter {
    pub fn new(
        _token: Option<String>,
        _save_token: Box<dyn Fn(Option<String>) + Send + Sync>,
    ) -> Self {
        Self
    }
    pub async fn prepare(&self) -> InsertStatus {
        self.status()
    }
    pub fn status(&self) -> InsertStatus {
        InsertStatus::default()
    }
    pub fn copy(&self, _text: &str) -> Result<(), InsertError> {
        Ok(())
    }
    pub async fn insert(&self, _text: &str, _key: PasteKey) -> Result<InsertOutcome, InsertError> {
        Ok(InsertOutcome::CopiedOnly {
            reason: "Stub insertion".into(),
        })
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn app_id() {
        assert_eq!(super::APP_ID, "com.joran.delulu-talks");
    }
}
