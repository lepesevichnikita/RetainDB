//! The state directory: one root per machine, holding the enrollment record,
//! the hint queue and the reconcile state.

use std::io;
use std::path::{Path, PathBuf};

use crate::atomic;
use crate::enrollment::Enrollment;
use crate::json;
use crate::queue::{FileQueue, QueueError};
use crate::sync_state::SyncState;

/// Environment variable that overrides the state directory (used by tests and
/// by operators running several enrollments side by side).
pub const STATE_DIR_ENV: &str = "RETAINDB_REPO_STATE_DIR";

/// On-disk state directory.
#[derive(Clone, Debug)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// Point at a state directory; nothing is created until a write happens.
    pub fn open(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Resolve the state directory from the environment.
    pub fn from_env() -> io::Result<Self> {
        if let Some(path) = std::env::var_os(STATE_DIR_ENV) {
            return Ok(Self::open(PathBuf::from(path)));
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is not set"))?;
        Ok(Self::open(home.join(".local/state/retaindb-repo")))
    }

    /// The directory itself.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where the enrollment record lives.
    pub fn enrollment_path(&self) -> PathBuf {
        self.dir.join("enrollment.json")
    }

    /// Where the hint queue lives.
    pub fn queue_path(&self) -> PathBuf {
        self.dir.join("queue.json")
    }

    /// Where the reconcile state lives.
    pub fn sync_path(&self) -> PathBuf {
        self.dir.join("sync.json")
    }

    /// Load the enrollment record.
    pub fn enrollment(&self) -> Result<Enrollment, StoreError> {
        let bytes = atomic::read(&self.enrollment_path())?.ok_or(StoreError::MissingEnrollment)?;
        let text = String::from_utf8(bytes)
            .map_err(|_| StoreError::Corrupt("enrollment is not utf-8".to_string()))?;
        let value = json::parse(&text).map_err(|error| StoreError::Corrupt(error.to_string()))?;
        Enrollment::from_json(&value)
            .ok_or_else(|| StoreError::Corrupt("enrollment fields missing".to_string()))
    }

    /// Trusted local enrollment id, if enrolled.
    pub fn enrollment_id(&self) -> Option<String> {
        self.enrollment().ok().map(|record| record.enrollment_id)
    }

    /// Enroll `root` (must be an existing directory) and persist the record.
    pub fn enroll(&self, root: &Path) -> Result<Enrollment, StoreError> {
        crate::enrollment::enroll(self, root)
    }

    /// Open the bounded hint queue.
    pub fn queue(&self) -> Result<FileQueue, QueueError> {
        FileQueue::open(&self.queue_path())
    }

    /// Load the reconcile state, or an empty one before the first sync.
    pub fn sync_state(&self) -> Result<SyncState, StoreError> {
        let bytes = atomic::read(&self.sync_path())?;
        match bytes {
            None => Ok(SyncState::default()),
            Some(bytes) => {
                let text = String::from_utf8(bytes)
                    .map_err(|_| StoreError::Corrupt("sync state is not utf-8".to_string()))?;
                SyncState::decode(&text).map_err(|error| StoreError::Corrupt(error.to_string()))
            }
        }
    }

    /// Persist the reconcile state.
    pub fn save_sync_state(&self, state: &SyncState) -> Result<(), StoreError> {
        save(&self.sync_path(), state.encode().as_bytes())
    }
}

/// Store failures.
#[derive(Debug)]
pub enum StoreError {
    /// No enrollment record: `enroll` has not run for this state dir.
    MissingEnrollment,
    /// The root argument is not an absolute path.
    RootNotAbsolute,
    /// The root argument does not name an existing directory.
    RootNotDirectory,
    /// Filesystem or encoding failure.
    Io(io::Error),
    /// A stored file did not parse.
    Corrupt(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingEnrollment => {
                f.write_str("no enrollment: run `retaindb-repo enroll --root <abs path>`")
            }
            Self::RootNotAbsolute => f.write_str("root must be an absolute path"),
            Self::RootNotDirectory => f.write_str("root must be an existing directory"),
            Self::Io(error) => write!(f, "state io error: {error}"),
            Self::Corrupt(reason) => write!(f, "state file corrupt: {reason}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Write `bytes` to `path` atomically.
pub fn save(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    atomic::write(path, bytes)?;
    Ok(())
}
