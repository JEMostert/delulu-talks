//! Vocabulary shelves: terms from enabled shelves go into the cleanup prompt.
use super::*;
use delulu_store::{StoreError, Vocabulary};

/// The shelves plus how many of their terms the cleanup prompt will use.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VocabularyView {
    #[serde(flatten)]
    vocabulary: Vocabulary,
    /// Distinct terms on enabled shelves.
    active_terms: usize,
    /// How many of those reach the prompt (it caps count and length).
    used_terms: usize,
}
fn view(vocabulary: Vocabulary) -> VocabularyView {
    let active = vocabulary.active_terms();
    VocabularyView {
        active_terms: active.len(),
        used_terms: delulu_cleanup::vocabulary_terms(&active).len(),
        vocabulary,
    }
}
fn change<R>(
    s: &Shell,
    f: impl FnOnce(&mut Vocabulary) -> Result<R, StoreError>,
) -> Result<VocabularyView, String> {
    s.store
        .update_vocabulary(f)
        .map(|(_, vocabulary)| view(vocabulary))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn get_vocabulary(s: State<'_, Shell>) -> VocabularyView {
    view(s.store.vocabulary())
}
#[tauri::command]
pub(crate) fn add_shelf(s: State<'_, Shell>, name: String) -> Result<VocabularyView, String> {
    change(&s, |v| v.add_shelf(&name).map(|_| ()))
}
#[tauri::command]
pub(crate) fn rename_shelf(
    s: State<'_, Shell>,
    id: String,
    name: String,
) -> Result<VocabularyView, String> {
    change(&s, |v| v.rename_shelf(&id, &name))
}
#[tauri::command]
pub(crate) fn delete_shelf(s: State<'_, Shell>, id: String) -> Result<VocabularyView, String> {
    change(&s, |v| {
        v.delete_shelf(&id);
        Ok(())
    })
}
#[tauri::command]
pub(crate) fn set_shelf_enabled(
    s: State<'_, Shell>,
    id: String,
    enabled: bool,
) -> Result<VocabularyView, String> {
    change(&s, |v| v.set_enabled(&id, enabled))
}
/// `text` may hold several terms separated by commas or newlines.
#[tauri::command]
pub(crate) fn add_terms(
    s: State<'_, Shell>,
    id: String,
    text: String,
) -> Result<VocabularyView, String> {
    change(&s, |v| v.add_terms(&id, &text))
}
#[tauri::command]
pub(crate) fn remove_term(
    s: State<'_, Shell>,
    id: String,
    term: String,
) -> Result<VocabularyView, String> {
    change(&s, |v| v.remove_term(&id, &term))
}
