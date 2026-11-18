//! The relay's own log file: size-capped with one rotated generation, and a
//! check for whether stdout already lands in it.
//!
//! The service units (launchd / systemd) redirect the relay's stdout and
//! stderr into the same `relay.log` the file layer appends to, so with both
//! layers on every line was written twice. `stdout_is` lets `init_tracing`
//! drop the stdout layer when stdout IS that file.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Default size at which `relay.log` is rotated to `relay.log.1`.
pub const DEFAULT_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// An append-only log file that rotates to `<path>.1` (replacing any older
/// one) once it reaches `max_bytes`. A failed rotation keeps writing to the
/// current file rather than losing lines.
pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    inner: Mutex<(File, u64)>,
}

impl RotatingFile {
    /// Open `path` for append (creating its directory), rotating first when
    /// it is already over `max_bytes`.
    pub fn open(path: &Path, max_bytes: u64) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size >= max_bytes {
            rotate(path)?;
        }
        let file = open_append(path)?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            path: path.to_path_buf(),
            max_bytes,
            inner: Mutex::new((file, size)),
        })
    }

    fn write_line(&self, buf: &[u8]) -> io::Result<usize> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("relay log lock poisoned"))?;
        if guard.1 >= self.max_bytes && rotate(&self.path).is_ok() {
            if let Ok(file) = open_append(&self.path) {
                *guard = (file, 0);
            }
        }
        let n = guard.0.write(buf)?;
        guard.1 += n as u64;
        Ok(n)
    }
}

fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().append(true).create(true).open(path)
}

fn rotate(path: &Path) -> io::Result<()> {
    let mut rotated = path.as_os_str().to_owned();
    rotated.push(".1");
    std::fs::rename(path, PathBuf::from(rotated))
}

/// The `tracing_subscriber` writer handle for a shared `RotatingFile`.
pub struct RotatingWriter<'a>(&'a RotatingFile);

impl Write for RotatingWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write_line(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RotatingFile {
    type Writer = RotatingWriter<'a>;
    fn make_writer(&'a self) -> Self::Writer {
        RotatingWriter(self)
    }
}

/// Whether this process's stdout is the file at `path` (same device and
/// inode): the service units redirect stdout into `relay.log`. Always false
/// off unix, or when either side cannot be inspected.
#[cfg(unix)]
pub fn stdout_is(path: &Path) -> bool {
    use std::os::fd::AsFd;
    use std::os::unix::fs::MetadataExt;
    let Ok(fd) = io::stdout().as_fd().try_clone_to_owned() else {
        return false;
    };
    let Ok(out) = File::from(fd).metadata() else {
        return false;
    };
    let Ok(log) = std::fs::metadata(path) else {
        return false;
    };
    out.is_file() && out.dev() == log.dev() && out.ino() == log.ino()
}

#[cfg(not(unix))]
pub fn stdout_is(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("relay-log-test-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn rotates_once_the_cap_is_reached() -> io::Result<()> {
        let dir = tmp_dir();
        let path = dir.join("relay.log");
        let log = RotatingFile::open(&path, 10)?;
        let mut w = RotatingWriter(&log);
        w.write_all(b"0123456789")?; // reaches the cap
        w.write_all(b"next\n")?; // rotates first
        assert_eq!(std::fs::read(dir.join("relay.log.1"))?, b"0123456789");
        assert_eq!(std::fs::read(&path)?, b"next\n");
        Ok(())
    }

    #[test]
    fn an_oversized_file_is_rotated_on_open() -> io::Result<()> {
        let dir = tmp_dir();
        let path = dir.join("relay.log");
        std::fs::write(&path, b"old old old")?;
        let _log = RotatingFile::open(&path, 4)?;
        assert_eq!(std::fs::read(dir.join("relay.log.1"))?, b"old old old");
        assert_eq!(std::fs::metadata(&path)?.len(), 0);
        Ok(())
    }

    #[test]
    fn stdout_is_not_an_unrelated_file() -> io::Result<()> {
        let dir = tmp_dir();
        let path = dir.join("relay.log");
        std::fs::write(&path, b"")?;
        assert!(!stdout_is(&path));
        Ok(())
    }
}
