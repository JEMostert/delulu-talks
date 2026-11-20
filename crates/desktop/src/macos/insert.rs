pub use crate::insert_types::{InsertError, InsertOutcome, InsertStatus, PasteKey};
pub use crate::APP_ID;
extern "C" {
    fn delulu_can_paste(prompt: bool) -> bool;
    fn delulu_paste() -> bool;
}
const PERMISSION: &str =
    "Allow Delulu Talks in System Settings → Privacy & Security → Accessibility. If pasting stops after an update, remove Delulu Talks from Accessibility and add it again.";
pub struct Inserter;
impl Inserter {
    pub fn new(_: Option<String>, _: Box<dyn Fn(Option<String>) + Send + Sync>) -> Self {
        Self
    }
    pub async fn prepare(&self) -> InsertStatus {
        unsafe { delulu_can_paste(true) };
        self.status()
    }
    pub fn status(&self) -> InsertStatus {
        let ready = unsafe { delulu_can_paste(false) };
        InsertStatus {
            ready,
            error: (!ready).then(|| PERMISSION.into()),
        }
    }
    pub fn copy(&self, text: &str) -> Result<(), InsertError> {
        arboard::Clipboard::new()
            .and_then(|mut b| b.set_text(text))
            .map_err(|e| InsertError::Clipboard(e.to_string()))
    }
    pub async fn insert(&self, text: &str, _: PasteKey) -> Result<InsertOutcome, InsertError> {
        self.copy(text)?;
        Ok(if unsafe { delulu_paste() } {
            InsertOutcome::Pasted
        } else {
            InsertOutcome::CopiedOnly {
                reason: PERMISSION.into(),
            }
        })
    }
}
