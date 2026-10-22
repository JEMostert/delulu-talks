//! WebKitGTK settings. Media capture stays disabled: audio is native, and the
//! renderer never needs camera, microphone or screen access.

use webkit2gtk::{SettingsExt, WebViewExt};

pub fn configure(view: &webkit2gtk::WebView) {
    if let Some(settings) = view.settings() {
        settings.set_enable_media_stream(false);
        settings.set_enable_developer_extras(cfg!(debug_assertions));
    }
}
