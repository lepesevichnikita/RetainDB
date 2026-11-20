//! The enrollment record: which repository root this state directory speaks
//! for, and the local id stamped into every hint. The id is generated locally
//! and never accepted from an event or a client.
//!
//! Two paths are kept when they differ: the canonical root (used for Git and
//! file access) and the alias exactly as the operator typed it. On macOS
//! `/var/...` and `/private/var/...` name the same directory, and a client's
//! `cwd` may use either spelling, so both are valid prefixes for an event path.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::json::{self, Json};
use crate::sha256;
use crate::store::{Store, StoreError};

/// A local enrollment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Enrollment {
    /// Opaque local id; the trust anchor for every queued hint.
    pub enrollment_id: String,
    /// Canonical absolute repository root.
    pub root: PathBuf,
    /// Other absolute spellings of the same root (never includes `root`).
    pub aliases: Vec<PathBuf>,
}

impl Enrollment {
    /// Build a record for `root`, deriving a stable id from root + creation
    /// time + pid so two state dirs never collide.
    pub fn create(root: &Path, alias: Option<&Path>) -> Self {
        let seed = format!(
            "{}:{}:{}",
            root.display(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|age| age.as_nanos())
                .unwrap_or(0),
            std::process::id()
        );
        let digest = sha256::hex_digest(seed.as_bytes());
        let aliases = match alias {
            Some(path) if path != root => vec![path.to_path_buf()],
            _ => Vec::new(),
        };
        Self {
            enrollment_id: format!("enr_{}", &digest[..24]),
            root: root.to_path_buf(),
            aliases,
        }
    }

    /// Every absolute spelling of the root that an event path may use.
    pub fn prefixes(&self) -> Vec<&Path> {
        let mut all = vec![self.root.as_path()];
        all.extend(self.aliases.iter().map(PathBuf::as_path));
        all
    }

    /// Does `candidate` name this root (directly or through an alias)?
    pub fn matches(&self, candidate: &Path) -> bool {
        self.prefixes().contains(&candidate)
    }

    /// Serialise for the state file.
    pub fn to_json(&self) -> Json {
        let aliases = self
            .aliases
            .iter()
            .map(|path| Json::String(path.to_string_lossy().into_owned()))
            .collect();
        json::object([
            ("enrollment_id", Json::from(self.enrollment_id.as_str())),
            ("root", Json::from(self.root.to_string_lossy().as_ref())),
            ("aliases", Json::Array(aliases)),
        ])
    }

    /// Parse a stored record.
    pub fn from_json(value: &Json) -> Option<Self> {
        let enrollment_id = value.get("enrollment_id")?.as_str()?.to_string();
        let root = PathBuf::from(value.get("root")?.as_str()?);
        let aliases = match value.get("aliases") {
            Some(Json::Array(items)) => items
                .iter()
                .filter_map(|item| item.as_str().map(PathBuf::from))
                .collect(),
            _ => Vec::new(),
        };
        Some(Self {
            enrollment_id,
            root,
            aliases,
        })
    }
}

/// A checked root: canonical path plus the spelling the operator supplied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckedRoot {
    pub canonical: PathBuf,
    pub given: PathBuf,
}

/// Validate that `root` is an absolute path to an existing directory.
pub fn checked_root(root: &Path) -> Result<CheckedRoot, StoreError> {
    if !root.is_absolute() {
        return Err(StoreError::RootNotAbsolute);
    }
    let canonical = root.canonicalize()?;
    if !canonical.is_dir() {
        return Err(StoreError::RootNotDirectory);
    }
    Ok(CheckedRoot {
        canonical,
        given: lexical(root),
    })
}

/// Normalise `.` and `..` without touching the filesystem.
fn lexical(path: &Path) -> PathBuf {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::CurDir => {}
            other => parts.push(other.as_os_str().to_os_string()),
        }
    }
    parts.iter().collect()
}

/// Enroll `root` in `store`, replacing any previous enrollment.
pub fn enroll(store: &Store, root: &Path) -> Result<Enrollment, StoreError> {
    let checked = checked_root(root)?;
    let record = Enrollment::create(&checked.canonical, Some(&checked.given));
    let bytes = record.to_json().encode();
    crate::store::save(&store.enrollment_path(), bytes.as_bytes())?;
    Ok(record)
}
