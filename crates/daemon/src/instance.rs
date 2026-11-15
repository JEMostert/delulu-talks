//! One daemon per socket.
//!
//! A daemon holds an exclusive `flock` on `<socket>.lock` for as long as it runs.
//! The kernel drops the lock when the process dies, however it dies, so the lock
//! tells a live daemon from a stale socket file left by a crash: with the lock in
//! hand, any socket file still there is stale and can be replaced. The lock file
//! itself is never deleted, because deleting it would let two daemons lock two
//! different files.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum BindError {
    AlreadyRunning(PathBuf),
    Io(PathBuf, io::Error),
}

impl std::fmt::Display for BindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindError::AlreadyRunning(path) => {
                write!(f, "another daemon is already running on {}", path.display())
            }
            BindError::Io(path, e) => write!(f, "{}: {e}", path.display()),
        }
    }
}

impl std::error::Error for BindError {}

/// A bound socket plus the lock that makes it ours. Dropping it removes the socket file.
#[derive(Debug)]
pub struct Instance {
    path: PathBuf,
    listener: Option<UnixListener>,
    _lock: File,
}

impl Instance {
    pub fn bind(path: &Path) -> Result<Self, BindError> {
        let io = |e| BindError::Io(path.to_owned(), e);
        if let Some(dir) = path.parent() {
            if !dir.exists() {
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(dir)
                    .map_err(io)?;
            }
        }
        let lock_path = lock_path(path);
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|e| BindError::Io(lock_path.clone(), e))?;
        // SAFETY: flock on a file descriptor this process owns.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = io::Error::last_os_error();
            return Err(if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
                BindError::AlreadyRunning(path.to_owned())
            } else {
                BindError::Io(lock_path, error)
            });
        }
        if let Ok(meta) = fs::symlink_metadata(path) {
            // Never delete something that is not a socket: a wrong --socket path
            // must not cost the user a file.
            if !meta.file_type().is_socket() {
                return Err(io(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "exists and is not a socket; refusing to replace it",
                )));
            }
            // Something that answers without holding the lock (an older build, or a
            // daemon started with a different lock layout) still counts as running.
            if UnixStream::connect(path).is_ok() {
                return Err(BindError::AlreadyRunning(path.to_owned()));
            }
            eprintln!("delulud: removing stale socket {}", path.display());
            fs::remove_file(path).map_err(io)?;
        }
        let listener = UnixListener::bind(path).map_err(io)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(io)?;
        listener.set_nonblocking(true).map_err(io)?;
        Ok(Self {
            path: path.to_owned(),
            listener: Some(listener),
            _lock: lock,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The listener, once; the instance keeps the lock and the socket file.
    pub fn take_listener(&mut self) -> Option<UnixListener> {
        self.listener.take()
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        // Still holding the lock, so the file is ours.
        let _ = fs::remove_file(&self.path);
    }
}

fn lock_path(socket: &Path) -> PathBuf {
    let mut name = socket.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_instance_is_refused_and_the_first_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run/daemon.sock");
        let first = Instance::bind(&path).unwrap();
        assert!(matches!(
            Instance::bind(&path),
            Err(BindError::AlreadyRunning(_))
        ));
        assert!(path.exists(), "the refused bind left the live socket alone");
        drop(first);
        assert!(!path.exists());
        Instance::bind(&path).unwrap();
    }

    #[test]
    fn a_stale_socket_file_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.sock");
        // A listener that went away without removing its file, as after a crash.
        drop(UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        let mut instance = Instance::bind(&path).unwrap();
        let listener = instance.take_listener().unwrap();
        let _client = UnixStream::connect(&path).unwrap();
        listener.set_nonblocking(false).unwrap();
        listener.accept().unwrap();
    }

    #[test]
    fn a_file_that_is_not_a_socket_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.txt");
        fs::write(&path, "keep me").unwrap();
        assert!(matches!(Instance::bind(&path), Err(BindError::Io(..))));
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep me");
    }

    #[test]
    fn the_socket_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh/daemon.sock");
        let _instance = Instance::bind(&path).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
    }
}
