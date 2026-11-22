//! Normalisation of client hook events into [`HookHintV1`].
//!
//! Each adapter documents the exact payload it accepts, with the source of
//! that shape, and ignores everything else. The rule everywhere: an event that
//! does not match the documented shape is rejected, and a rejected event makes
//! the hook fail open (exit 0, nothing queued).
//!
//! # Claude Code
//!
//! `PostToolUse` hook payload on stdin for the `Read` tool (Claude Code hooks
//! reference, "PostToolUse input"):
//!
//! ```json
//! {"session_id":"...","hook_event_name":"PostToolUse","tool_name":"Read",
//!  "tool_input":{"file_path":"/abs/repo/src/main.rs"},
//!  "tool_use_id":"toolu_01...","cwd":"/abs/repo"}
//! ```
//!
//! `tool_input.file_path` is absolute on macOS/Linux; `cwd` is the session's
//! working directory. The adapter resolves the path against the enrollment
//! root, keeps it only if it lands inside the root, and rejects the event
//! otherwise. `tool_use_id` becomes the opaque correlation id.
//!
//! # Hermes
//!
//! `post_tool_call` payload for `read_file` (Hermes hook contract):
//!
//! ```json
//! {"tool_name":"read_file","tool_input":{"path":"src/main.rs"},"cwd":"/abs/repo",
//!  "extra":{"status":"success","result":{"content":"...encoded..."}}}
//! ```
//!
//! Only `tool_input.path` and `extra.status` are read. `extra.result` is an
//! encoded body; the adapter never decodes it, stores it or looks at it. A
//! non-`success` status means the read did not happen, so nothing is queued.
//!
//! # Codex
//!
//! Codex does not expose a per-file read event with a trustworthy path, so this
//! adapter accepts lifecycle events only (`SessionStart`, `Stop`) and maps them
//! to `kind = reconcile`. Any `file_read`-shaped Codex event is rejected:
//! inferring reads from Codex would invent data the client never sent.

use std::path::{Path, PathBuf};

use crate::hint::{Client, HintKind, PathReject, RelPath, MAX_CORRELATION_BYTES};
use crate::json::Json;

/// Schema version understood by this build. Events carrying a different
/// `schema_version` are rejected, not upgraded.
pub const SCHEMA_VERSION: u64 = 1;

/// Why an event was refused. Every variant means "fail open, queue nothing".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    NotAnObject,
    NotEnrolled,
    Malformed,
    Oversized,
    FieldTooLong(&'static str),
    UnsupportedSchema,
    UnsupportedEvent,
    UnsupportedTool,
    MissingField(&'static str),
    Path(PathReject),
    OutsideRoot,
    FailedStatus,
}

impl std::fmt::Display for Reject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAnObject => f.write_str("event is not a json object"),
            Self::NotEnrolled => f.write_str("state dir has no enrollment"),
            Self::Malformed => f.write_str("malformed json event"),
            Self::Oversized => f.write_str("event larger than the size limit"),
            Self::FieldTooLong(name) => write!(f, "field {name} longer than the size limit"),
            Self::UnsupportedSchema => f.write_str("unsupported schema_version"),
            Self::UnsupportedEvent => f.write_str("unsupported hook event"),
            Self::UnsupportedTool => f.write_str("unsupported tool"),
            Self::MissingField(name) => write!(f, "missing field {name}"),
            Self::Path(reason) => write!(f, "rejected path: {reason}"),
            Self::OutsideRoot => f.write_str("path resolves outside the enrollment root"),
            Self::FailedStatus => f.write_str("tool call did not succeed"),
        }
    }
}

/// A normalised event, before the trusted enrollment id is attached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Adapted {
    pub kind: HintKind,
    pub correlation_id: Option<String>,
}

/// Normalise one client event. `roots` are the absolute spellings of the
/// enrolled repository root and are used lexically only: the adapter never
/// touches the filesystem.
pub fn adapt(client: Client, event: &Json, roots: &[&Path]) -> Result<Adapted, Reject> {
    if !matches!(event, Json::Object(_)) {
        return Err(Reject::NotAnObject);
    }
    check_schema(event)?;
    match client {
        Client::Claude => claude(event, roots),
        Client::Hermes => hermes(event, roots),
        Client::Codex => codex(event, roots),
    }
}

/// Reject any `schema_version` this build does not implement.
pub fn check_schema(event: &Json) -> Result<(), Reject> {
    match event.get("schema_version") {
        None => Ok(()),
        Some(value) if value.as_u64() == Some(SCHEMA_VERSION) => Ok(()),
        Some(_) => Err(Reject::UnsupportedSchema),
    }
}

/// Claude Code `PostToolUse` / `Read`.
fn claude(event: &Json, roots: &[&Path]) -> Result<Adapted, Reject> {
    let tool = event
        .get("tool_name")
        .and_then(Json::as_str)
        .ok_or(Reject::MissingField("tool_name"))?;
    if !tool.eq_ignore_ascii_case("Read") {
        return Err(Reject::UnsupportedTool);
    }
    let raw = event
        .get("tool_input")
        .and_then(|input| input.get("file_path"))
        .and_then(Json::as_str)
        .ok_or(Reject::MissingField("tool_input.file_path"))?;
    let cwd = event.get("cwd").and_then(Json::as_str).map(Path::new);
    let path = relative_path(roots, cwd, raw)?;
    Ok(Adapted {
        kind: HintKind::FileRead(path),
        correlation_id: correlation_id(event)?,
    })
}

/// Hermes `post_tool_call` / `read_file`, success only.
fn hermes(event: &Json, roots: &[&Path]) -> Result<Adapted, Reject> {
    let tool = event
        .get("tool_name")
        .and_then(Json::as_str)
        .ok_or(Reject::MissingField("tool_name"))?;
    if !tool.eq_ignore_ascii_case("read_file") {
        return Err(Reject::UnsupportedTool);
    }
    let status_ok = event
        .get("extra")
        .and_then(|extra| extra.get("status"))
        .and_then(Json::as_str)
        .map(|status| status == "success")
        .ok_or(Reject::MissingField("extra.status"))?;
    if !status_ok {
        return Err(Reject::FailedStatus);
    }
    let raw = event
        .get("tool_input")
        .and_then(|input| input.get("path"))
        .and_then(Json::as_str)
        .ok_or(Reject::MissingField("tool_input.path"))?;
    let cwd = event.get("cwd").and_then(Json::as_str).map(Path::new);
    let path = relative_path(roots, cwd, raw)?;
    Ok(Adapted {
        kind: HintKind::FileRead(path),
        correlation_id: correlation_id(event)?,
    })
}

/// Codex: lifecycle events map to `reconcile`.
fn codex(event: &Json, _roots: &[&Path]) -> Result<Adapted, Reject> {
    match event.get("hook_event_name").and_then(Json::as_str) {
        Some("SessionStart" | "Stop") => Ok(Adapted {
            kind: HintKind::Reconcile,
            correlation_id: None,
        }),
        Some(_) => Err(Reject::UnsupportedEvent),
        None => Err(Reject::MissingField("hook_event_name")),
    }
}

/// The opaque id a client attaches to a tool call. A value near the event
/// limit is payload, not an id, so it is refused rather than stored.
fn correlation_id(event: &Json) -> Result<Option<String>, Reject> {
    let Some(raw) = event.get("tool_use_id").and_then(Json::as_str) else {
        return Ok(None);
    };
    if raw.len() > MAX_CORRELATION_BYTES {
        return Err(Reject::FieldTooLong("tool_use_id"));
    }
    Ok(Some(raw.to_string()))
}

/// Resolve an event path against the enrollment root, lexically.
fn relative_path(roots: &[&Path], cwd: Option<&Path>, raw: &str) -> Result<RelPath, Reject> {
    let raw_path = Path::new(raw);
    if raw_path.is_absolute() {
        let inner = under_root(roots, raw_path)?;
        return RelPath::parse(&inner.to_string_lossy()).map_err(Reject::Path);
    }
    let base = match cwd {
        None => PathBuf::new(),
        Some(dir) if dir.is_absolute() => under_root(roots, dir)?,
        Some(dir) => dir.to_path_buf(),
    };
    RelPath::parse(&base.join(raw_path).to_string_lossy()).map_err(Reject::Path)
}

/// Strip whichever enrolled root prefix matches. An empty remainder means the
/// path *is* the root, which is valid for `cwd` and rejected by [`RelPath`].
fn under_root(roots: &[&Path], path: &Path) -> Result<PathBuf, Reject> {
    for root in roots {
        if let Ok(inner) = path.strip_prefix(root) {
            return Ok(inner.to_path_buf());
        }
    }
    Err(Reject::OutsideRoot)
}
