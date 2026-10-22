//! WebKitGTK configuration the renderer depends on.
//!
//! WebKitGTK disables media capture by default and, even when enabled, defers
//! `getUserMedia` until the window has keyboard focus. Dictation records while
//! another application is focused, so that runtime feature is turned off. The
//! feature-flag API (WebKitGTK 2.42+) is not wrapped by the webkit2gtk crate.

use std::ffi::{c_char, c_int, c_void, CStr};

use webkit2gtk::glib::translate::ToGlibPtr;
use webkit2gtk::{SettingsExt, WebViewExt};

extern "C" {
    fn webkit_settings_get_all_features() -> *mut c_void;
    fn webkit_feature_list_get_length(list: *mut c_void) -> usize;
    fn webkit_feature_list_get(list: *mut c_void, index: usize) -> *mut c_void;
    fn webkit_feature_list_unref(list: *mut c_void);
    fn webkit_feature_get_identifier(feature: *mut c_void) -> *const c_char;
    fn webkit_settings_set_feature_enabled(
        settings: *mut webkit2gtk::ffi::WebKitSettings,
        feature: *mut c_void,
        enabled: c_int,
    );
}

const DISABLED_FEATURES: &[&str] = &["GetUserMediaRequiresFocus"];

pub fn configure(view: &webkit2gtk::WebView) {
    let Some(settings) = view.settings() else {
        return;
    };
    settings.set_enable_media_stream(true);
    settings.set_enable_webaudio(true);
    settings.set_media_playback_requires_user_gesture(false);
    settings.set_enable_developer_extras(cfg!(debug_assertions));
    let raw: *mut webkit2gtk::ffi::WebKitSettings = settings.to_glib_none().0;
    unsafe {
        let list = webkit_settings_get_all_features();
        if list.is_null() {
            return;
        }
        for index in 0..webkit_feature_list_get_length(list) {
            let feature = webkit_feature_list_get(list, index);
            let identifier = webkit_feature_get_identifier(feature);
            if identifier.is_null() {
                continue;
            }
            let identifier = CStr::from_ptr(identifier).to_string_lossy();
            if DISABLED_FEATURES.contains(&identifier.as_ref()) {
                webkit_settings_set_feature_enabled(raw, feature, 0);
            }
        }
        webkit_feature_list_unref(list);
    }
}
