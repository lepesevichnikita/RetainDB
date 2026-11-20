//! The bounded hint queue.
//!
//! One JSON file per state directory, replaced atomically on every enqueue.
//! Hints are metadata only: enrollment id, client, adapter version, kind, one
//! validated relative path and an optional opaque correlation id.
//!
//! Trade-off (recorded deliberately, see README): a SQLite binding could not
//! be verified to build offline, so durability lives in this file with
//! temp-file+rename atomicity instead of a transactional store. Concurrent
//! writers are not supported; the hook is a single short-lived process and the
//! file is small.

use std::io;
use std::path::{Path, PathBuf};

use crate::atomic;
use crate::hint::{HintKind, HookHintV1};
use crate::json::{self, Json};

/// Hard cap on queued hints. Reaching it sets the overflow flag instead of
/// growing the file without bound.
pub const MAX_HINTS: usize = 256;

/// One queued hint, as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HintRecord {
    pub enrollment_id: String,
    pub client: String,
    pub adapter_version: String,
    pub kind: String,
    pub path: Option<String>,
    pub correlation_id: Option<String>,
    pub sequence: u64,
}

/// Outcome of one enqueue attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Enqueue {
    /// A new hint was appended.
    Added,
    /// The same path was already queued and the entry was refreshed.
    Coalesced,
    /// The queue is at capacity; the hint was dropped and the flag is set.
    Overflow,
}

/// What `status` reports about the queue.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QueueSnapshot {
    pub depth: usize,
    pub overflow: bool,
}

/// Failure modes of the queue file.
#[derive(Debug)]
pub enum QueueError {
    Io(io::Error),
    Corrupt(String),
}

impl std::fmt::Display for QueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "queue io error: {error}"),
            Self::Corrupt(reason) => write!(f, "queue file corrupt: {reason}"),
        }
    }
}

impl std::error::Error for QueueError {}

impl From<io::Error> for QueueError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// The enqueue seam.
///
/// The shipped implementation is [`FileQueue`] (atomic file replacement). This
/// trait exists so a transactional backend (for example a SQLite queue) can be
/// dropped in later without touching the hook: a SQLite binding could not be
/// verified to build offline, so the file queue is what ships.
pub trait HintSink {
    /// Enqueue one validated hint, durably, before returning.
    fn enqueue(&mut self, hint: &HookHintV1) -> Result<Enqueue, QueueError>;
}

/// File-backed bounded queue.
pub struct FileQueue {
    path: PathBuf,
    enrollment_id: Option<String>,
    hints: Vec<HintRecord>,
    overflow: bool,
    next_sequence: u64,
}

impl FileQueue {
    /// Open the queue file, or start empty when it does not exist yet.
    pub fn open(path: &Path) -> Result<Self, QueueError> {
        let bytes = atomic::read(path)?;
        match bytes {
            None => Ok(Self {
                path: path.to_path_buf(),
                enrollment_id: None,
                hints: Vec::new(),
                overflow: false,
                next_sequence: 0,
            }),
            Some(bytes) => {
                let text = String::from_utf8(bytes)
                    .map_err(|_| QueueError::Corrupt("queue is not utf-8".to_string()))?;
                let mut stored = decode(&text)?;
                // The cap is enforced on load as well as on enqueue: a file
                // written under an older cap must be trimmed here, or every
                // later save would keep rewriting more than `MAX_HINTS`.
                if stored.hints.len() > MAX_HINTS {
                    stored.hints.truncate(MAX_HINTS);
                    stored.overflow = true;
                }
                Ok(Self {
                    path: path.to_path_buf(),
                    enrollment_id: stored.enrollment_id,
                    next_sequence: stored
                        .hints
                        .iter()
                        .map(|hint| hint.sequence + 1)
                        .max()
                        .unwrap_or(0),
                    hints: stored.hints,
                    overflow: stored.overflow,
                })
            }
        }
    }

    /// Number of queued hints.
    pub fn depth(&self) -> usize {
        self.hints.len()
    }

    /// Whether a hint was dropped because the queue was full.
    pub fn overflow(&self) -> bool {
        self.overflow
    }

    /// Borrow the queued hints in arrival order.
    pub fn hints(&self) -> &[HintRecord] {
        &self.hints
    }

    /// Small snapshot for `status`.
    pub fn snapshot(&self) -> QueueSnapshot {
        QueueSnapshot {
            depth: self.hints.len(),
            overflow: self.overflow,
        }
    }

    /// Where an equivalent hint already sits in the queue.
    fn position_of(&self, record: &HintRecord) -> Option<usize> {
        self.hints
            .iter()
            .position(|hint| hint.kind == record.kind && hint.path == record.path)
    }

    /// A hint for a different enrollment resets the queue: stale ids never mix.
    fn adopt(&mut self, hint: &HookHintV1) {
        if self.enrollment_id.as_deref() != Some(hint.enrollment_id.as_str()) {
            self.enrollment_id = Some(hint.enrollment_id.clone());
            self.hints.clear();
            self.overflow = false;
            self.next_sequence = 0;
        }
    }

    /// Persist the current queue.
    pub fn save(&self) -> Result<(), QueueError> {
        let text = StoredQueue {
            enrollment_id: self.enrollment_id.clone(),
            overflow: self.overflow,
            hints: self.hints.clone(),
        }
        .encode();
        atomic::write(&self.path, text.as_bytes())?;
        Ok(())
    }
}

/// On-disk queue document.
struct StoredQueue {
    enrollment_id: Option<String>,
    overflow: bool,
    hints: Vec<HintRecord>,
}

impl StoredQueue {
    fn encode(&self) -> String {
        let hints = self.hints.iter().map(encode_hint).collect::<Vec<Json>>();
        json::object([
            ("enrollment_id", Json::from(self.enrollment_id.as_deref())),
            ("overflow", Json::from(self.overflow)),
            ("hints", Json::Array(hints)),
        ])
        .encode()
    }
}

fn encode_hint(hint: &HintRecord) -> Json {
    json::object([
        ("enrollment_id", Json::from(hint.enrollment_id.as_str())),
        ("client", Json::from(hint.client.as_str())),
        ("adapter_version", Json::from(hint.adapter_version.as_str())),
        ("kind", Json::from(hint.kind.as_str())),
        ("path", Json::from(hint.path.as_deref())),
        ("correlation_id", Json::from(hint.correlation_id.as_deref())),
        ("sequence", Json::from(hint.sequence)),
    ])
}

/// Wire name of a hint kind.
pub fn kind_name(kind: &HintKind) -> &'static str {
    match kind {
        HintKind::FileRead(_) => "file_read",
        HintKind::Reconcile => "reconcile",
    }
}

/// The path a hint carries, if any.
pub fn path_of(kind: &HintKind) -> Option<String> {
    match kind {
        HintKind::FileRead(path) => Some(path.as_str().to_string()),
        HintKind::Reconcile => None,
    }
}

impl HintSink for FileQueue {
    /// Enqueue one validated hint, persisting before returning.
    ///
    /// Same enrollment + same kind + same path refreshes the existing entry, so
    /// a session that reads one file repeatedly stays one pending hint. At
    /// capacity a *new* hint sets the overflow flag and is dropped; a refresh of
    /// an already-queued path still works, because it does not grow the file.
    fn enqueue(&mut self, hint: &HookHintV1) -> Result<Enqueue, QueueError> {
        self.adopt(hint);
        let record = HintRecord {
            enrollment_id: hint.enrollment_id.clone(),
            client: hint.client.as_str().to_string(),
            adapter_version: hint.adapter_version.clone(),
            kind: kind_name(&hint.kind).to_string(),
            path: path_of(&hint.kind),
            correlation_id: hint.correlation_id.clone(),
            sequence: self.next_sequence,
        };
        if let Some(index) = self.position_of(&record) {
            let kept = self.hints[index].sequence;
            let mut refreshed = record;
            refreshed.sequence = kept;
            self.hints[index] = refreshed;
            self.save()?;
            return Ok(Enqueue::Coalesced);
        }
        if self.hints.len() >= MAX_HINTS {
            self.overflow = true;
            self.save()?;
            return Ok(Enqueue::Overflow);
        }
        self.hints.push(record);
        self.next_sequence += 1;
        self.save()?;
        Ok(Enqueue::Added)
    }
}

/// Decode a stored queue.
fn decode(text: &str) -> Result<StoredQueue, QueueError> {
    let value = json::parse(text).map_err(|error| QueueError::Corrupt(error.to_string()))?;
    let enrollment_id = match value.get("enrollment_id") {
        Some(Json::String(text)) => Some(text.clone()),
        _ => None,
    };
    let overflow = value
        .get("overflow")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let raw_hints = match value.get("hints") {
        Some(Json::Array(items)) => items,
        _ => return Err(QueueError::Corrupt("hints is not an array".to_string())),
    };
    let hints = raw_hints
        .iter()
        .map(decode_hint)
        .collect::<Result<Vec<HintRecord>, QueueError>>()?;
    Ok(StoredQueue {
        enrollment_id,
        overflow,
        hints,
    })
}

fn decode_hint(value: &Json) -> Result<HintRecord, QueueError> {
    let field = |name: &str| {
        value
            .get(name)
            .and_then(Json::as_str)
            .ok_or_else(|| QueueError::Corrupt(format!("hint field {name} missing")))
    };
    Ok(HintRecord {
        enrollment_id: field("enrollment_id")?.to_string(),
        client: field("client")?.to_string(),
        adapter_version: field("adapter_version")?.to_string(),
        kind: field("kind")?.to_string(),
        path: value.get("path").and_then(Json::as_str).map(str::to_string),
        correlation_id: value
            .get("correlation_id")
            .and_then(Json::as_str)
            .map(str::to_string),
        sequence: value.get("sequence").and_then(Json::as_u64).unwrap_or(0),
    })
}
