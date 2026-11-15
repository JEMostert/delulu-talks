//! The downloader. Each file streams into `<file>.part`, next to a small
//! `<file>.part.meta` that records which SHA-256 the partial bytes belong to. A later
//! call, also after a restart, continues with an HTTP Range request. The finished
//! file is hashed (a resumed one includes the bytes already on disk) and only then
//! renamed into place, so a file under its final name is always complete.
use crate::{Model, ModelFile};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cancelled")]
    Cancelled,
    #[error("not enough disk space: {} needed, {} free", gb(*needed), gb(*available))]
    NoSpace { needed: u64, available: u64 },
    #[error("checksum mismatch for {0}")]
    Checksum(&'static str),
    #[error("{0}")]
    Network(String),
    #[error("{0}")]
    Io(#[from] io::Error),
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}

#[derive(Clone)]
pub struct Options {
    /// Failed attempts in a row, without any new bytes, before giving up.
    pub retries: u32,
    /// The wait after the first failure; it doubles up to `max_backoff`.
    pub backoff: Duration,
    pub max_backoff: Duration,
    pub connect_timeout: Duration,
    /// A connection that delivers nothing for this long counts as dropped.
    pub read_timeout: Duration,
    /// Progress reaches the callback at most this often (and once at the end).
    pub progress_every: Duration,
    /// Free bytes on the filesystem that holds the folder.
    pub free_space: fn(&Path) -> io::Result<u64>,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            retries: 5,
            backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(15),
            read_timeout: Duration::from_secs(30),
            progress_every: Duration::from_millis(100),
            free_space,
        }
    }
}

/// Downloads every missing file of `model` into `dir`, reporting progress over all
/// of them as `(done, total)` bytes. Cancelling keeps the partial file for later.
pub fn download(
    dir: &Path,
    model: &Model,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<(), Error> {
    download_with(&Options::default(), dir, model.files, progress, cancel)
}

pub fn download_with(
    opts: &Options,
    dir: &Path,
    files: &[ModelFile],
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> Result<(), Error> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Error::Cancelled);
    }
    fs::create_dir_all(dir)?;
    let total: u64 = files.iter().map(|f| f.bytes).sum();
    let needed: u64 = files
        .iter()
        .filter(|f| !f.ready(dir))
        .map(|f| f.bytes - resumable_len(dir, f))
        .sum();
    if needed > 0 {
        // Keep 5% spare so the disk is not left completely full.
        let available = (opts.free_space)(dir)?;
        if available < needed + needed / 20 {
            return Err(Error::NoSpace { needed, available });
        }
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(opts.connect_timeout))
        .timeout_recv_response(Some(opts.read_timeout))
        .timeout_per_read(Some(opts.read_timeout))
        .build()
        .into();
    let mut report = Throttle::new(opts.progress_every, total, progress);
    let mut before = 0;
    for file in files {
        if !file.ready(dir) {
            fetch(
                opts,
                &agent,
                dir,
                file,
                &mut |done| report.send(before + done),
                cancel,
            )?;
        }
        before += file.bytes;
    }
    report.finish();
    Ok(())
}

/// Removes the model's files and any partial download of them.
pub fn remove(dir: &Path, model: &Model) -> io::Result<()> {
    for f in model.files {
        for p in [dir.join(f.file), part_path(dir, f), meta_path(dir, f)] {
            match fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(io::Error::new(e.kind(), format!("{}: {e}", p.display()))),
            }
        }
    }
    Ok(())
}

pub fn part_path(dir: &Path, file: &ModelFile) -> PathBuf {
    dir.join(format!("{}.part", file.file))
}
fn meta_path(dir: &Path, file: &ModelFile) -> PathBuf {
    dir.join(format!("{}.part.meta", file.file))
}

/// Bytes of an earlier partial download that a new attempt can keep.
fn resumable_len(dir: &Path, file: &ModelFile) -> u64 {
    let ours = fs::read_to_string(meta_path(dir, file)).is_ok_and(|m| m.trim() == file.sha256);
    let len = part_path(dir, file).metadata().map_or(0, |m| m.len());
    if ours && len <= file.bytes {
        len
    } else {
        0
    }
}

struct Throttle<'a> {
    every: Duration,
    total: u64,
    last: Option<Instant>,
    done: u64,
    sink: &'a mut dyn FnMut(u64, u64),
}
impl<'a> Throttle<'a> {
    fn new(every: Duration, total: u64, sink: &'a mut dyn FnMut(u64, u64)) -> Self {
        Self {
            every,
            total,
            last: None,
            done: 0,
            sink,
        }
    }
    fn send(&mut self, done: u64) {
        self.done = done;
        if self.last.is_none_or(|t| t.elapsed() >= self.every) {
            self.last = Some(Instant::now());
            (self.sink)(done, self.total);
        }
    }
    fn finish(&mut self) {
        (self.sink)(self.total, self.total);
    }
}

/// One attempt failed; `Retry` errors are worth another try after a pause.
enum Failure {
    Retry(String),
    Stop(Error),
}
impl From<io::Error> for Failure {
    fn from(e: io::Error) -> Self {
        Failure::Stop(Error::Io(e))
    }
}

/// The partial file of one download and the hash of the bytes in it.
struct Part {
    file: File,
    hash: Sha256,
    len: u64,
}
impl Part {
    fn restart(&mut self) -> io::Result<()> {
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.hash = Sha256::new();
        self.len = 0;
        Ok(())
    }
}

fn fetch(
    opts: &Options,
    agent: &ureq::Agent,
    dir: &Path,
    info: &ModelFile,
    progress: &mut dyn FnMut(u64),
    cancel: &AtomicBool,
) -> Result<(), Error> {
    let path = dir.join(info.file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let part_file = part_path(dir, info);
    let meta = meta_path(dir, info);
    let keep = resumable_len(dir, info);
    let mut part = Part {
        file: OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&part_file)?,
        hash: Sha256::new(),
        len: 0,
    };
    part.file.set_len(keep)?;
    if keep == 0 {
        // Only after the old bytes are gone, or a kill here would vouch for them.
        fs::write(&meta, format!("{}\n", info.sha256))?;
    }
    // The hash has to cover the bytes from an earlier attempt too.
    let mut buf = vec![0u8; 256 * 1024];
    while part.len < keep {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let n = part.file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        part.hash.update(&buf[..n]);
        part.len += n as u64;
    }
    if keep > 0 {
        log::info!("resuming {} at {} of {} bytes", info.file, keep, info.bytes);
    }
    progress(part.len);

    let mut failures = 0u32;
    while part.len < info.bytes {
        let start = part.len;
        let failure = match attempt(agent, info, &mut part, progress, cancel) {
            Ok(()) => continue,
            Err(Failure::Stop(e)) => {
                part.file.flush()?;
                return Err(e);
            }
            Err(Failure::Retry(why)) => why,
        };
        if part.len > start {
            failures = 0;
        }
        failures += 1;
        if failures > opts.retries {
            return Err(Error::Network(failure));
        }
        let wait = opts
            .backoff
            .saturating_mul(1 << (failures - 1).min(16))
            .min(opts.max_backoff);
        log::warn!(
            "download {} stopped at {} bytes ({failure}); retry {failures} in {wait:?}",
            info.file,
            part.len
        );
        sleep_unless_cancelled(wait, cancel)?;
    }

    part.file.sync_all()?;
    let hash = format!("{:x}", part.hash.finalize());
    drop(part.file);
    if hash != info.sha256 {
        let _ = fs::remove_file(&part_file);
        let _ = fs::remove_file(&meta);
        return Err(Error::Checksum(info.file));
    }
    fs::rename(&part_file, &path)?;
    let _ = fs::remove_file(&meta);
    Ok(())
}

/// What the network thread of one attempt hands to the download loop.
enum Net {
    Head {
        status: u16,
        content_range: Option<String>,
        content_length: Option<u64>,
    },
    Data(Vec<u8>),
    Failed(String),
}

/// Requests `info.url` from byte `from` on its own thread, so that a Cancel is
/// noticed within 100 ms even while a connect or a read hangs. When the receiver
/// goes away, the thread stops at its next chunk or network timeout.
fn request(agent: &ureq::Agent, url: &'static str, from: u64) -> mpsc::Receiver<Net> {
    let (tx, rx) = mpsc::sync_channel(4);
    let agent = agent.clone();
    std::thread::spawn(move || {
        // Byte offsets only make sense on the file as stored, never on a gzip stream.
        let mut request = agent.get(url).header("Accept-Encoding", "identity");
        if from > 0 {
            request = request.header("Range", format!("bytes={from}-"));
        }
        let response = match request.call() {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(Net::Failed(e.to_string()));
                return;
            }
        };
        let status = response.status().as_u16();
        let head = Net::Head {
            status,
            content_range: response
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
            content_length: response.body().content_length(),
        };
        if tx.send(head).is_err() || !matches!(status, 200 | 206) {
            return;
        }
        let mut body = response.into_body().into_reader();
        loop {
            let mut chunk = vec![0u8; 256 * 1024];
            let msg = match body.read(&mut chunk) {
                Ok(0) => return,
                Ok(n) => {
                    chunk.truncate(n);
                    Net::Data(chunk)
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => Net::Failed(e.to_string()),
            };
            let failed = matches!(msg, Net::Failed(_));
            if tx.send(msg).is_err() || failed {
                return;
            }
        }
    });
    rx
}

/// The next message, or `None` once the thread is done; `Cancelled` on Cancel.
fn next(rx: &mpsc::Receiver<Net>, cancel: &AtomicBool) -> Result<Option<Net>, Failure> {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Failure::Stop(Error::Cancelled));
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(msg) => return Ok(Some(msg)),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
        }
    }
}

fn attempt(
    agent: &ureq::Agent,
    info: &ModelFile,
    part: &mut Part,
    progress: &mut dyn FnMut(u64),
    cancel: &AtomicBool,
) -> Result<(), Failure> {
    if cancel.load(Ordering::Relaxed) {
        return Err(Failure::Stop(Error::Cancelled));
    }
    let rx = request(agent, info.url, part.len);
    let (status, content_range, content_length) = match next(&rx, cancel)? {
        Some(Net::Head {
            status,
            content_range,
            content_length,
        }) => (status, content_range, content_length),
        Some(Net::Failed(e)) => return Err(Failure::Retry(e)),
        Some(Net::Data(_)) | None => return Err(Failure::Retry("no response".into())),
    };
    match status {
        206 if part.len > 0 => {
            let start = content_range.as_deref().and_then(range_start);
            if start != Some(part.len) {
                part.restart()?;
                progress(0);
                return Err(Failure::Retry(format!(
                    "server resumed at {start:?} instead of {}",
                    part.len
                )));
            }
        }
        200 | 206 => {
            if part.len > 0 {
                log::info!(
                    "{}: the server ignored the Range request; restarting",
                    info.file
                );
                part.restart()?;
                progress(0);
            }
        }
        416 => {
            part.restart()?;
            progress(0);
            return Err(Failure::Retry("server rejected the resume range".into()));
        }
        408 | 425 | 429 | 500..=599 => {
            return Err(Failure::Retry(format!("server answered {status}")))
        }
        _ => {
            return Err(Failure::Stop(Error::Network(format!(
                "server answered {status}"
            ))))
        }
    }
    let remaining = info.bytes - part.len;
    if let Some(len) = content_length {
        if len != remaining {
            return Err(Failure::Stop(Error::Network(format!(
                "server offers {len} bytes, expected {remaining}"
            ))));
        }
    }
    while let Some(msg) = next(&rx, cancel)? {
        let chunk = match msg {
            Net::Data(chunk) => chunk,
            Net::Failed(e) => return Err(Failure::Retry(e)),
            Net::Head { .. } => continue,
        };
        if part.len + chunk.len() as u64 > info.bytes {
            part.restart()?;
            return Err(Failure::Stop(Error::Network(format!(
                "server sent more than the expected {} bytes",
                info.bytes
            ))));
        }
        part.file.write_all(&chunk)?;
        part.hash.update(&chunk);
        part.len += chunk.len() as u64;
        progress(part.len);
    }
    if part.len < info.bytes {
        return Err(Failure::Retry("connection closed early".into()));
    }
    Ok(())
}

/// The first byte of a `Content-Range: bytes <start>-<end>/<total>` header.
fn range_start(value: &str) -> Option<u64> {
    value
        .trim()
        .strip_prefix("bytes ")?
        .split('-')
        .next()?
        .trim()
        .parse()
        .ok()
}

fn sleep_unless_cancelled(wait: Duration, cancel: &AtomicBool) -> Result<(), Error> {
    let until = Instant::now() + wait;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Ok(());
        }
        std::thread::sleep(left.min(Duration::from_millis(100)));
    }
}

#[allow(clippy::unnecessary_cast)]
fn free_space(dir: &Path) -> io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and `stat` is a valid out pointer.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_range() {
        assert_eq!(range_start("bytes 100-199/200"), Some(100));
        assert_eq!(range_start("bytes */200"), None);
        assert_eq!(range_start("items 1-2/3"), None);
    }
}
