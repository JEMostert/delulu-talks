#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub bound: bool,
    pub trigger: Option<String>,
    pub error: Option<String>,
}
