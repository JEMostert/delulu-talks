fn main() {
    // The recording pill runs as a helper of this same binary. Handle it before
    // anything else, or the single-instance plugin would swallow the launch.
    if std::env::args().nth(1).as_deref() == Some("--pill") {
        std::process::exit(delulu_overlay::run_pill());
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none()
        && std::path::Path::new("/sys/module/nvidia").exists()
    {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }
    delulu_talks::run();
}
