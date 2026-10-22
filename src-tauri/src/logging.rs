//! A small stderr logger for the `log` facade the crates use. `RUST_LOG`
//! sets the level (`error`, `warn`, `info`, `debug`, `trace`; default `info`).

use log::{Level, LevelFilter, Log, Metadata, Record};

struct StderrLogger;

impl Log for StderrLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // Dependencies log a lot at debug level; keep those to warnings.
        let target = record.target();
        let ours = target.starts_with("delulu");
        if !ours && record.level() > Level::Warn {
            return;
        }
        eprintln!("[{} {}] {}", record.level(), target, record.args());
    }

    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

pub fn init() {
    let level = match std::env::var("RUST_LOG").unwrap_or_default().to_ascii_lowercase().as_str() {
        "error" => LevelFilter::Error,
        "warn" => LevelFilter::Warn,
        "debug" => LevelFilter::Debug,
        "trace" => LevelFilter::Trace,
        "off" => LevelFilter::Off,
        _ => LevelFilter::Info,
    };
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(level);
    }
}
