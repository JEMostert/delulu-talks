fn main() {
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none()
        && std::path::Path::new("/sys/module/nvidia").exists()
    {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
    delulu_talks::run();
}
