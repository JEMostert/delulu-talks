//! Log lines from the shared crates (store, portals) go to stderr, which systemd
//! sends to the journal. Like everything else the daemon prints, they never hold
//! dictated text.

struct Stderr;

impl log::Log for Stderr {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!(
                "delulud: {} {}: {}",
                record.level().as_str().to_lowercase(),
                record.target(),
                record.args()
            );
        }
    }
    fn flush(&self) {}
}

/// Installs the logger once; later calls do nothing.
pub fn init() {
    static LOGGER: Stderr = Stderr;
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}
