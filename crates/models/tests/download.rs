//! The downloader against a local HTTP server that drops, stalls or ignores Range.
use delulu_models::{download_with, part_path, Error, ModelFile, Options};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SIZE: usize = 300_000;
const CUT: usize = 100_000;

#[derive(Clone, Copy)]
enum Fault {
    /// The first response closes after `CUT` bytes.
    Drop,
    /// The first response sends `CUT` bytes and then goes silent.
    Stall,
    /// Like `Drop`, and every response is a full 200 that ignores Range.
    IgnoreRange,
    /// No fault; responses trickle out in small pieces.
    Slow,
}

struct Server {
    url: String,
    /// The Range header of every request, in order.
    ranges: Arc<Mutex<Vec<Option<String>>>>,
}

fn content() -> Vec<u8> {
    (0..SIZE).map(|i| (i * 31 % 251) as u8).collect()
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn serve(fault: Fault) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
    let ranges = Arc::new(Mutex::new(Vec::new()));
    let seen = ranges.clone();
    std::thread::spawn(move || {
        for (n, stream) in listener.incoming().enumerate() {
            let Ok(stream) = stream else { break };
            let seen = seen.clone();
            std::thread::spawn(move || respond(stream, n == 0, fault, &seen));
        }
    });
    Server { url, ranges }
}

fn respond(mut stream: TcpStream, first: bool, fault: Fault, seen: &Mutex<Vec<Option<String>>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            }
        }
    }
    seen.lock().unwrap().push(range.clone());
    let body = content();
    let start = match (&range, fault) {
        (Some(r), Fault::Drop | Fault::Stall | Fault::Slow) => r
            .strip_prefix("bytes=")
            .and_then(|r| r.strip_suffix('-'))
            .and_then(|s| s.parse::<usize>().ok()),
        _ => None,
    };
    let head = match start {
        Some(s) => format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {s}-{}/{SIZE}\r\nConnection: close\r\n\r\n",
            SIZE - s,
            SIZE - 1
        ),
        None => format!("HTTP/1.1 200 OK\r\nContent-Length: {SIZE}\r\nConnection: close\r\n\r\n"),
    };
    let body = &body[start.unwrap_or(0)..];
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    match fault {
        Fault::Slow => {
            for chunk in body.chunks(10_000) {
                if stream.write_all(chunk).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        _ if first => {
            let _ = stream.write_all(&body[..CUT]);
            let _ = stream.flush();
            if let Fault::Stall = fault {
                std::thread::sleep(Duration::from_secs(5));
            }
        }
        _ => {
            let _ = stream.write_all(body);
        }
    }
}

fn file(url: &str, sha256: String) -> ModelFile {
    ModelFile {
        file: "model.bin",
        url: url.to_string().leak(),
        sha256: sha256.leak(),
        bytes: SIZE as u64,
    }
}

fn opts() -> Options {
    Options {
        backoff: Duration::from_millis(10),
        read_timeout: Duration::from_millis(300),
        progress_every: Duration::ZERO,
        free_space: |_| Ok(u64::MAX),
        ..Options::default()
    }
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("delulu-models-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn range_from(n: usize) -> Option<String> {
    Some(format!("bytes={n}-"))
}

#[test]
fn dropped_or_stalled_connection_resumes_with_range() {
    for (name, fault) in [("drop", Fault::Drop), ("stall", Fault::Stall)] {
        let server = serve(fault);
        let dir = temp_dir(name);
        let info = file(&server.url, sha(&content()));
        let mut seen = Vec::new();
        download_with(
            &opts(),
            &dir,
            std::slice::from_ref(&info),
            &mut |done, total| seen.push((done, total)),
            &AtomicBool::new(false),
        )
        .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            std::fs::read(dir.join("model.bin")).unwrap(),
            content(),
            "{name}"
        );
        assert_eq!(
            *server.ranges.lock().unwrap(),
            vec![None, range_from(CUT)],
            "{name}"
        );
        assert!(!part_path(&dir, &info).exists(), "{name}");
        assert_eq!(seen.last(), Some(&(SIZE as u64, SIZE as u64)), "{name}");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn server_that_ignores_range_restarts_cleanly() {
    let server = serve(Fault::IgnoreRange);
    let dir = temp_dir("ignore-range");
    let info = file(&server.url, sha(&content()));
    download_with(
        &opts(),
        &dir,
        std::slice::from_ref(&info),
        &mut |_, _| {},
        &AtomicBool::new(false),
    )
    .unwrap();
    // The second answer was a full 200; appending it would corrupt the file.
    assert_eq!(*server.ranges.lock().unwrap(), vec![None, range_from(CUT)]);
    assert_eq!(std::fs::read(dir.join("model.bin")).unwrap(), content());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn corrupted_part_fails_the_hash_and_the_next_try_starts_over() {
    let server = serve(Fault::Slow);
    let dir = temp_dir("corrupt");
    let info = file(&server.url, sha(&content()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut bad = content()[..CUT].to_vec();
    bad[10] ^= 0xff;
    std::fs::write(part_path(&dir, &info), bad).unwrap();
    std::fs::write(dir.join("model.bin.part.meta"), info.sha256).unwrap();
    let cancel = AtomicBool::new(false);
    let result = download_with(
        &opts(),
        &dir,
        std::slice::from_ref(&info),
        &mut |_, _| {},
        &cancel,
    );
    assert!(
        matches!(result, Err(Error::Checksum("model.bin"))),
        "{result:?}"
    );
    assert!(!dir.join("model.bin").exists());
    assert!(!part_path(&dir, &info).exists());

    download_with(
        &opts(),
        &dir,
        std::slice::from_ref(&info),
        &mut |_, _| {},
        &cancel,
    )
    .unwrap();
    assert_eq!(*server.ranges.lock().unwrap(), vec![range_from(CUT), None]);
    assert_eq!(std::fs::read(dir.join("model.bin")).unwrap(), content());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn part_from_another_revision_is_not_resumed() {
    let server = serve(Fault::Slow);
    let dir = temp_dir("stale");
    let info = file(&server.url, sha(&content()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(part_path(&dir, &info), &content()[..CUT]).unwrap();
    std::fs::write(dir.join("model.bin.part.meta"), sha(b"older revision")).unwrap();
    download_with(
        &opts(),
        &dir,
        std::slice::from_ref(&info),
        &mut |_, _| {},
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(*server.ranges.lock().unwrap(), vec![None]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn cancel_keeps_a_part_that_a_later_call_resumes() {
    let server = serve(Fault::Slow);
    let dir = temp_dir("cancel");
    let info = file(&server.url, sha(&content()));
    let cancel = AtomicBool::new(false);
    let result = download_with(
        &opts(),
        &dir,
        std::slice::from_ref(&info),
        &mut |done, _| {
            if done >= 50_000 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
        &cancel,
    );
    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
    let kept = std::fs::metadata(part_path(&dir, &info)).unwrap().len() as usize;
    assert!((50_000..SIZE).contains(&kept), "kept {kept}");
    assert!(!dir.join("model.bin").exists());

    // A new call, as after an app restart, continues from the kept bytes.
    cancel.store(false, Ordering::Relaxed);
    let mut first = None;
    download_with(
        &opts(),
        &dir,
        std::slice::from_ref(&info),
        &mut |done, _| {
            first.get_or_insert(done);
        },
        &cancel,
    )
    .unwrap();
    assert_eq!(first, Some(kept as u64), "progress starts at the kept size");
    assert_eq!(*server.ranges.lock().unwrap(), vec![None, range_from(kept)]);
    assert_eq!(std::fs::read(dir.join("model.bin")).unwrap(), content());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn too_little_disk_space_fails_before_any_request() {
    let server = serve(Fault::Slow);
    let dir = temp_dir("space");
    let info = file(&server.url, sha(&content()));
    let opts = Options {
        free_space: |_| Ok(SIZE as u64),
        ..opts()
    };
    let result = download_with(
        &opts,
        &dir,
        std::slice::from_ref(&info),
        &mut |_, _| {},
        &AtomicBool::new(false),
    );
    // The file fits, but not with the 5% spare.
    assert!(
        matches!(result, Err(Error::NoSpace { needed, .. }) if needed == SIZE as u64),
        "{result:?}"
    );
    assert!(server.ranges.lock().unwrap().is_empty());
    assert!(!part_path(&dir, &info).exists());
    std::fs::remove_dir_all(dir).unwrap();
}
