//! Domain types for a hook hint. Everything here is metadata: the crate never
//! opens, hashes or parses the file a hint points at.

use std::fmt;

/// The client that produced an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    Claude,
    Codex,
    Hermes,
}

impl Client {
    /// Adapter version this build implements for the client.
    pub const ADAPTER_VERSION: &'static str = "1";

    /// Parse the `--client` flag value.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "hermes" => Some(Self::Hermes),
            _ => None,
        }
    }

    /// Wire name, also used in queue records.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Hermes => "hermes",
        }
    }
}

/// Why a path was refused at the trust boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathReject {
    Empty,
    Absolute,
    Traversal,
    Component,
    DrivePrefixed,
    ForeignSeparator,
    Control,
    TooLong,
}

impl fmt::Display for PathReject {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Empty => "empty path",
            Self::Absolute => "absolute path",
            Self::Traversal => "path traversal",
            Self::Component => "empty or '.' path component",
            Self::DrivePrefixed => "drive-prefixed path",
            Self::ForeignSeparator => "backslash in path",
            Self::Control => "control character in path",
            Self::TooLong => "path longer than the size limit",
        };
        f.write_str(text)
    }
}

/// Longest path accepted. Linux `PATH_MAX`: a tool call that reports a longer
/// path is not naming a file anyone can open.
pub const MAX_PATH_BYTES: usize = 4096;

/// Longest opaque correlation id accepted. Tool-call ids are tens of bytes;
/// anything near this is payload, not an id, and the queue is rewritten in
/// full on every event.
pub const MAX_CORRELATION_BYTES: usize = 256;

/// A path that is provably relative to the enrollment root and contains no
/// traversal. Constructing one is the only way to name a file in a hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelPath(String);

impl RelPath {
    /// Validate raw text from an untrusted event.
    ///
    /// Purely lexical: no filesystem access, so a hook can validate a path
    /// without ever opening the file it names.
    pub fn parse(raw: &str) -> Result<Self, PathReject> {
        if raw.is_empty() {
            return Err(PathReject::Empty);
        }
        if raw.len() > MAX_PATH_BYTES {
            return Err(PathReject::TooLong);
        }
        if raw.chars().any(char::is_control) {
            return Err(PathReject::Control);
        }
        if raw.starts_with('/') {
            return Err(PathReject::Absolute);
        }
        if raw.contains('\\') {
            return Err(PathReject::ForeignSeparator);
        }
        if raw.as_bytes().get(1) == Some(&b':') {
            return Err(PathReject::DrivePrefixed);
        }
        for part in raw.split('/') {
            match part {
                "" | "." => return Err(PathReject::Component),
                ".." => return Err(PathReject::Traversal),
                _ => {}
            }
        }
        Ok(Self(raw.to_string()))
    }

    /// Borrow the validated text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What the client asked us to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HintKind {
    FileRead(RelPath),
    Reconcile,
}

/// One validated hint, assembled from a client event plus the trusted local
/// enrollment id. The enrollment id never comes from the event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookHintV1 {
    pub enrollment_id: String,
    pub client: Client,
    pub adapter_version: String,
    pub kind: HintKind,
    pub correlation_id: Option<String>,
}
