//! Reconcile state: the digest cache, the pending change set and the receipt
//! watermark. Persisted as JSON next to the queue.
//!
//! The watermark only moves when a receipt for a generation is confirmed
//! explicitly; nothing in this crate advances it on its own.

use std::collections::BTreeMap;
use std::io;

use crate::json::{self, Json};

/// Per-file digest cache entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileState {
    /// SHA-256 of the file content, lowercase hex.
    pub digest: String,
    /// Size in bytes at the time the digest was taken.
    pub size: u64,
    /// Modification time in microseconds since the Unix epoch.
    pub mtime_us: u64,
    /// Generation in which the content was last verified.
    pub verified_generation: u64,
}

/// What happened to a path in the current batch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    /// The path exists with this content.
    Upsert,
    /// The path no longer exists in the working tree.
    Tombstone,
}

impl ChangeKind {
    /// Wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upsert => "upsert",
            Self::Tombstone => "tombstone",
        }
    }

    /// Parse a stored name.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "upsert" => Some(Self::Upsert),
            "tombstone" => Some(Self::Tombstone),
            _ => None,
        }
    }
}

/// One unconfirmed change. Offline edits coalesce: the map holds the latest
/// state per path, never a history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingChange {
    pub kind: ChangeKind,
    /// Content digest for an upsert, `None` for a tombstone.
    pub digest: Option<String>,
    /// Generation that last touched this path.
    pub generation: u64,
}

/// Durable reconcile state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncState {
    /// Last generation confirmed by an explicit receipt.
    pub watermark: u64,
    /// Last generation produced by a sync run.
    pub generation: u64,
    /// Digest cache, keyed by validated relative path.
    pub files: BTreeMap<String, FileState>,
    /// Unconfirmed changes, keyed by validated relative path.
    pub pending: BTreeMap<String, PendingChange>,
    /// Rotation cursor for the bounded recheck of unchanged files.
    pub recheck_cursor: usize,
}

impl SyncState {
    /// Changes still waiting for a receipt.
    pub fn pending_count(&self) -> usize {
        self.pending
            .values()
            .filter(|change| change.generation > self.watermark)
            .count()
    }

    /// Encode for storage.
    pub fn to_json(&self) -> Json {
        let files = self
            .files
            .iter()
            .map(|(path, entry)| (path.clone(), entry.to_json()))
            .collect();
        let pending = self
            .pending
            .iter()
            .map(|(path, change)| (path.clone(), change.to_json()))
            .collect();
        json::object([
            ("watermark", Json::from(self.watermark)),
            ("generation", Json::from(self.generation)),
            ("recheck_cursor", Json::from(self.recheck_cursor as u64)),
            ("files", Json::Object(files)),
            ("pending", Json::Object(pending)),
        ])
    }

    /// Parse stored state.
    pub fn from_json(value: &Json) -> Result<Self, String> {
        if value.as_object().is_none() {
            return Err("state is not a json object".to_string());
        }
        Ok(Self {
            watermark: number(value, "watermark"),
            generation: number(value, "generation"),
            recheck_cursor: number(value, "recheck_cursor") as usize,
            files: map_of(value, "files", FileState::from_json)?,
            pending: map_of(value, "pending", PendingChange::from_json)?,
        })
    }

    /// Encode to text.
    pub fn encode(&self) -> String {
        self.to_json().encode()
    }

    /// Parse stored state text.
    pub fn decode(text: &str) -> Result<Self, io::Error> {
        let value = json::parse(text)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
        Self::from_json(&value).map_err(|reason| io::Error::new(io::ErrorKind::InvalidData, reason))
    }

    /// Record an explicit receipt: everything up to `generation` is confirmed.
    pub fn confirm(&mut self, generation: u64) {
        self.watermark = self.watermark.max(generation);
        let watermark = self.watermark;
        self.pending
            .retain(|_, change| change.generation > watermark);
    }
}

impl FileState {
    fn to_json(&self) -> Json {
        json::object([
            ("digest", Json::from(self.digest.as_str())),
            ("size", Json::from(self.size)),
            ("mtime_us", Json::from(self.mtime_us)),
            ("verified_generation", Json::from(self.verified_generation)),
        ])
    }

    fn from_json(value: &Json) -> Option<Self> {
        Some(Self {
            digest: value.get("digest")?.as_str()?.to_string(),
            size: value.get("size")?.as_u64()?,
            mtime_us: value.get("mtime_us")?.as_u64()?,
            verified_generation: value
                .get("verified_generation")
                .and_then(Json::as_u64)
                .unwrap_or(0),
        })
    }
}

impl PendingChange {
    fn to_json(&self) -> Json {
        json::object([
            ("kind", Json::from(self.kind.as_str())),
            ("digest", Json::from(self.digest.as_deref())),
            ("generation", Json::from(self.generation)),
        ])
    }

    fn from_json(value: &Json) -> Option<Self> {
        Some(Self {
            kind: ChangeKind::parse(value.get("kind")?.as_str()?)?,
            digest: value
                .get("digest")
                .and_then(Json::as_str)
                .map(str::to_string),
            generation: value.get("generation")?.as_u64()?,
        })
    }
}

fn number(value: &Json, key: &str) -> u64 {
    value.get(key).and_then(Json::as_u64).unwrap_or(0)
}

fn map_of<T>(
    value: &Json,
    key: &str,
    parse: fn(&Json) -> Option<T>,
) -> Result<BTreeMap<String, T>, String> {
    let Some(pairs) = value.get(key).and_then(Json::as_object) else {
        return Ok(BTreeMap::new());
    };
    let mut map = BTreeMap::new();
    for (name, item) in pairs {
        let parsed = parse(item).ok_or_else(|| format!("{key}.{name} is malformed"))?;
        map.insert(name.clone(), parsed);
    }
    Ok(map)
}
