//! The outbound batch transport: one bounded request per generation, classified
//! by outcome and retried only where a retry can help.
//!
//! Wire contract (documented here because this module is its only author):
//! `POST <ENDPOINT_URL>` with
//! `{"enrollment_id":"enr_…","generation":N,"part_no":1,"changes":[{"path":"…","kind":"upsert|tombstone","digest":"…"|null}]}`
//! and the scoped grant in `X-RetainDB-Repo-Index-Grant`. The receipt is
//! `{"generation":N}`, and only the generation in a parsed receipt advances the
//! watermark.
//!
//! Invocation: `curl` gets the grant header and the body as a config stream on
//! stdin (`--config -`). The credential is never an argument, so no other process
//! can read it from `ps` or `/proc/<pid>/cmdline` while the request is in flight,
//! and it never touches a file.
//!
//! Bounds are checked before the request leaves: an entry count and a wire byte
//! limit, both explicit in [`Limits`]. A batch over either is refused locally
//! instead of being uploaded and bounced with a 413.
//!
//! Idempotency: every change of one generation travels as part 1 of that
//! generation, and a retry resends the identical body and part number, so the
//! server recognises the duplicate instead of applying it twice.
//!
//! Nothing here logs or retains a request body: paths and digests are metadata,
//! the body is never formatted into a message, and [`Request`]'s `Debug` prints
//! a length instead of the payload.

use std::fmt;
use std::io::Write;
use std::process::{Command, Stdio};

use crate::json::{self, Json};
use crate::store::{Store, StoreError};
use crate::sync::{self, SyncError};
use crate::sync_state::{PendingChange, SyncState};

/// Environment variable holding the scoped grant. The only way a credential
/// enters this client: never a command-line flag, never a state file.
pub const GRANT_ENV: &str = "RETAINDB_REPO_INDEX_GRANT";

/// Environment variable holding the batch endpoint.
pub const ENDPOINT_ENV: &str = "RETAINDB_REPO_INDEX_URL";

/// Header the server reads the grant from.
pub const GRANT_HEADER: &str = "x-retaindb-repo-index-grant";

/// Every change of one generation travels as this part number, so a retry is
/// the same part rather than a new one.
pub const PART_NO: u64 = 1;

/// Appended by curl to its stdout, so the status code is separable from the body.
const STATUS_TRAILER: &str = "\n%{http_code}";

/// Cap on the answer this client will buffer. A receipt is a few bytes; an
/// endpoint returning more than this is not a receipt, and reading it
/// unbounded would let the peer decide how much memory this process uses.
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;

/// Request bounds and retry budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Hard cap on the encoded request body.
    pub max_wire_bytes: usize,
    /// Hard cap on the number of changes in one batch.
    pub max_entries: usize,
    /// Total attempts, not retries: 1 means "send once".
    pub max_attempts: u32,
    /// First backoff step; doubles per attempt.
    pub backoff_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_wire_bytes: 256 * 1024,
            max_entries: 512,
            max_attempts: 3,
            backoff_ms: 250,
        }
    }
}

/// A scoped grant.
///
/// `Debug` is redacted and there is deliberately no `Display`: the only way to
/// read the token is [`Credential::expose`], which the sender calls once, at the
/// point where it becomes a header.
#[derive(Clone)]
pub struct Credential(String);

impl Credential {
    /// Validate a token: non-empty and free of line breaks, which would let a
    /// value smuggle a second header into the request.
    pub fn parse(token: &str) -> Result<Self, SendError> {
        let trimmed = token.trim();
        if trimmed.is_empty() || trimmed.contains(['\r', '\n']) {
            return Err(SendError::UnusableCredential);
        }
        Ok(Self(trimmed.to_string()))
    }

    /// Read the grant from the environment.
    pub fn from_env() -> Result<Self, SendError> {
        let raw = std::env::var(GRANT_ENV).map_err(|_| SendError::MissingCredential)?;
        Self::parse(&raw)
    }

    /// The token itself, for the one caller that turns it into a header.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credential(<redacted>)")
    }
}

/// Where a batch goes and which grant proves it.
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub url: String,
    pub credential: Credential,
}

impl Endpoint {
    /// Read the endpoint and the grant from the environment.
    pub fn from_env() -> Result<Self, SendError> {
        let url = std::env::var(ENDPOINT_ENV).map_err(|_| SendError::MissingEndpoint)?;
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return Err(SendError::MissingEndpoint);
        }
        Ok(Self {
            url: trimmed.to_string(),
            credential: Credential::from_env()?,
        })
    }
}

/// What a receipt confirms: the generation the server now holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub generation: u64,
}

/// One request, ready to leave.
#[derive(Clone)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub body: String,
    pub credential: Credential,
}

impl fmt::Debug for Request {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Request")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("body_bytes", &self.body.len())
            .field("credential", &self.credential)
            .finish()
    }
}

/// Why no response came back. Fixed phrases, so no stream content can carry a
/// credential into a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lost {
    /// `curl` could not be started at all.
    Spawn,
    /// `--max-time` elapsed.
    Timeout,
    /// DNS, TCP or TLS failure: nothing was received.
    Connection,
    /// The answer exceeded [`MAX_RESPONSE_BYTES`], so it cannot be a receipt.
    TooBig,
    /// `curl` exited 0 but printed no status code.
    NoStatus,
    /// Any other non-zero exit.
    Exit(i32),
}

impl fmt::Display for Lost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Spawn => f.write_str("cannot run curl"),
            Self::Timeout => f.write_str("the request timed out"),
            Self::Connection => f.write_str("the endpoint could not be reached"),
            Self::TooBig => f.write_str("the answer was larger than the receipt limit"),
            Self::NoStatus => f.write_str("curl printed no status code"),
            Self::Exit(code) => write!(f, "curl exited {code}"),
        }
    }
}

/// What one send produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply {
    /// The endpoint answered.
    Status { status: u16, body: String },
    /// Nothing came back; a retry may still succeed.
    Lost(Lost),
}

/// The wire seam. [`CurlTransport`] is the shipped implementation; tests drive
/// a fake through the same interface, so classification and retry are testable
/// without a socket.
pub trait Transport {
    /// Send one request and report what came back. Idempotent by contract: the
    /// caller may send the identical request again.
    fn send(&self, request: &Request) -> Reply;
}

/// Shells out to the system `curl`, which keeps this crate dependency-free and
/// buildable offline.
pub struct CurlTransport {
    timeout_seconds: u64,
}

impl Default for CurlTransport {
    fn default() -> Self {
        Self {
            timeout_seconds: 30,
        }
    }
}

impl Transport for CurlTransport {
    fn send(&self, request: &Request) -> Reply {
        let mut child = match command_for(self.timeout_seconds, request).spawn() {
            Ok(child) => child,
            Err(_) => return Reply::Lost(Lost::Spawn),
        };
        // The grant and the body travel as curl's stdin config, so the credential
        // is never one of the child's arguments. `EPIPE` is not fatal here: curl
        // may already have failed, and the exit status says what happened.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(config_for(request).as_bytes());
        }
        match child.wait_with_output() {
            Ok(output) if output.status.success() => status_of(&output.stdout),
            Ok(output) => Reply::Lost(lost_of(output.status.code())),
            Err(_) => Reply::Lost(Lost::Exit(-1)),
        }
    }
}

/// The curl invocation for one request: arguments only, so the credential is not
/// among them. No shell, so nothing can be split or expanded; no `--location`, so
/// a redirect cannot carry the grant header to another host; `--proto` keeps an
/// env-supplied URL from reading local files. The grant header and the body reach
/// curl on stdin through `--config -`; see [`config_for`].
pub fn command_for(timeout_seconds: u64, request: &Request) -> Command {
    let mut command = Command::new("curl");
    command
        .arg("--silent")
        .arg("--max-time")
        .arg(timeout_seconds.to_string())
        .arg("--connect-timeout")
        .arg(timeout_seconds.min(10).to_string())
        .arg("--proto")
        .arg("=https,http")
        .arg("--max-filesize")
        .arg(MAX_RESPONSE_BYTES.to_string())
        .arg("--request")
        .arg(request.method)
        .arg("--header")
        .arg("content-type: application/json")
        .arg("--config")
        .arg("-")
        .arg("--write-out")
        .arg(STATUS_TRAILER)
        .arg("--url")
        .arg(&request.url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

/// The options `curl` reads from stdin: the grant header and the request body.
///
/// This is the only channel the credential travels on. A `--header` argument
/// would be readable through `ps` and `/proc/<pid>/cmdline` for as long as the
/// request lasts, and a `--header @file` indirection would leave it on disk. The
/// body is one config line, far below curl's own line limit at the default
/// [`Limits::max_wire_bytes`].
fn config_for(request: &Request) -> String {
    let grant = format!("{GRANT_HEADER}: {}", request.credential.expose());
    format!(
        "header = \"{}\"\ndata-binary = \"{}\"\n",
        config_value(&grant),
        config_value(&request.body)
    )
}

/// Quote one config value: a backslash or a quote would otherwise end the value,
/// and a raw line break would end the line before the closing quote. Every other
/// byte, including UTF-8 and tabs, passes through unchanged.
fn config_value(text: &str) -> String {
    let mut value = String::with_capacity(text.len() + 2);
    for ch in text.chars() {
        match ch {
            '\\' => value.push_str("\\\\"),
            '"' => value.push_str("\\\""),
            '\n' => value.push_str("\\n"),
            '\r' => value.push_str("\\r"),
            other => value.push(other),
        }
    }
    value
}

/// Split `<body>\n<status>` into a [`Reply`].
fn status_of(stdout: &[u8]) -> Reply {
    let text = String::from_utf8_lossy(stdout);
    let Some((body, code)) = text.rsplit_once('\n') else {
        return Reply::Lost(Lost::NoStatus);
    };
    match code.trim().parse::<u16>() {
        Ok(status) => Reply::Status {
            status,
            body: body.to_string(),
        },
        Err(_) => Reply::Lost(Lost::NoStatus),
    }
}

fn lost_of(code: Option<i32>) -> Lost {
    match code {
        Some(28) => Lost::Timeout,
        Some(63) => Lost::TooBig,
        Some(6 | 7 | 35 | 52 | 55 | 56) => Lost::Connection,
        Some(code) => Lost::Exit(code),
        None => Lost::Exit(-1),
    }
}

/// Ship the unconfirmed changes of the stored generation, and advance the
/// watermark to the generation the receipt names.
///
/// Returns `None` when nothing is pending: no request, no receipt. Every other
/// outcome either produced a parsed receipt or an error, and only the receipt
/// moves the watermark.
pub fn deliver(
    store: &Store,
    transport: &dyn Transport,
    endpoint: &Endpoint,
    limits: &Limits,
) -> Result<Option<Receipt>, SendError> {
    let state = store.sync_state().map_err(state_error)?;
    if state.pending.is_empty() {
        return Ok(None);
    }
    let enrollment = store.enrollment().map_err(state_error)?;
    let body = batch_body(&enrollment.enrollment_id, &state);
    within(limits, &body, state.pending.len())?;
    let request = Request {
        method: "POST",
        url: endpoint.url.clone(),
        body,
        credential: endpoint.credential.clone(),
    };
    let receipt = receipt_of(&exchange(transport, &request, limits)?)?;
    sync::confirm_receipt(store, receipt.generation).map_err(SendError::Sync)?;
    Ok(Some(receipt))
}

fn state_error(error: StoreError) -> SendError {
    SendError::Sync(SyncError::Store(error))
}

/// Encode the batch. One part per generation, part number fixed.
fn batch_body(enrollment_id: &str, state: &SyncState) -> String {
    let changes = state
        .pending
        .iter()
        .map(|(path, change)| change_json(path, change))
        .collect();
    json::object([
        ("enrollment_id", Json::from(enrollment_id)),
        ("generation", Json::from(state.generation)),
        ("part_no", Json::from(PART_NO)),
        ("changes", Json::Array(changes)),
    ])
    .encode()
}

fn change_json(path: &str, change: &PendingChange) -> Json {
    json::object([
        ("path", Json::from(path)),
        ("kind", Json::from(change.kind.as_str())),
        ("digest", Json::from(change.digest.as_deref())),
    ])
}

/// Refuse an oversized batch locally, before any byte is uploaded.
fn within(limits: &Limits, body: &str, entries: usize) -> Result<(), SendError> {
    if entries > limits.max_entries {
        return Err(SendError::TooManyEntries {
            count: entries,
            limit: limits.max_entries,
        });
    }
    if body.len() > limits.max_wire_bytes {
        return Err(SendError::BodyTooLarge {
            bytes: body.len(),
            limit: limits.max_wire_bytes,
        });
    }
    Ok(())
}

/// Exchange the request and return the body of the successful answer.
///
/// Retries only where a retry can help: 429 and 5xx, and a lost response. The
/// identical request is resent, so the server sees the same part number again.
fn exchange(
    transport: &dyn Transport,
    request: &Request,
    limits: &Limits,
) -> Result<String, SendError> {
    let attempts = limits.max_attempts.max(1);
    let mut attempt = 1;
    loop {
        match classify(transport.send(request)) {
            Step::Delivered(body) => return Ok(body),
            Step::Final(error) => return Err(error),
            Step::Again(retry) if attempt >= attempts => return Err(retry.after(attempt)),
            Step::Again(_) => {}
        }
        backoff(attempt, limits.backoff_ms);
        attempt += 1;
    }
}

/// Wait before the next attempt, doubling from `base_ms`.
fn backoff(attempt: u32, base_ms: u64) {
    let delay = base_ms.saturating_mul(1u64 << attempt.min(16));
    if delay > 0 {
        std::thread::sleep(std::time::Duration::from_millis(delay));
    }
}

/// The receipt inside a successful answer.
fn receipt_of(body: &str) -> Result<Receipt, SendError> {
    let value = json::parse(body).map_err(|_| SendError::UnreadableReceipt)?;
    let generation = value
        .get("generation")
        .and_then(Json::as_u64)
        .ok_or(SendError::UnreadableReceipt)?;
    Ok(Receipt { generation })
}

/// One attempt's outcome.
enum Step {
    /// A 2xx with the body to parse a receipt from.
    Delivered(String),
    /// Nothing to retry: the outcome is final.
    Final(SendError),
    /// Worth another attempt.
    Again(Retry),
}

/// A retryable outcome, remembering why so the last attempt can say it.
#[derive(Clone, Copy)]
enum Retry {
    Status(u16),
    NoResponse,
}

impl Retry {
    /// The final error once the attempt budget is spent.
    fn after(self, attempts: u32) -> SendError {
        match self {
            Self::Status(status) => SendError::Exhausted { status, attempts },
            Self::NoResponse => SendError::Lost { attempts },
        }
    }
}

fn classify(reply: Reply) -> Step {
    match reply {
        Reply::Status { status, body } => classify_status(status, body),
        Reply::Lost(Lost::Spawn) => Step::Final(SendError::Unavailable),
        // An answer past the receipt bound is not retryable into a receipt.
        Reply::Lost(Lost::TooBig) => Step::Final(SendError::UnreadableReceipt),
        // Listed one by one: a new `Lost` variant must decide its own class
        // instead of inheriting "retryable" from a catch-all.
        Reply::Lost(Lost::Timeout)
        | Reply::Lost(Lost::Connection)
        | Reply::Lost(Lost::NoStatus)
        | Reply::Lost(Lost::Exit(_)) => Step::Again(Retry::NoResponse),
    }
}

fn classify_status(status: u16, body: String) -> Step {
    match status {
        200..=299 => Step::Delivered(body),
        // Retrying an oversized body cannot make it smaller.
        413 => Step::Final(SendError::TooLarge { status }),
        // A refused grant and a wrong request are permanent for this attempt.
        401 | 403 => Step::Final(SendError::Denied { status }),
        429 | 500..=599 => Step::Again(Retry::Status(status)),
        other => Step::Final(SendError::Rejected { status: other }),
    }
}

/// Every failed outcome this transport can report. No variant carries a
/// credential, a request body or a response body.
#[derive(Debug)]
pub enum SendError {
    /// `ENDPOINT_ENV` is unset or empty.
    MissingEndpoint,
    /// `GRANT_ENV` is unset.
    MissingCredential,
    /// The credential is empty or would inject a header.
    UnusableCredential,
    /// More changes than the entry limit allows.
    TooManyEntries { count: usize, limit: usize },
    /// A larger encoded body than the wire limit allows.
    BodyTooLarge { bytes: usize, limit: usize },
    /// The server refused the body as too large (413). Not retried.
    TooLarge { status: u16 },
    /// 401/403: the grant was refused. Not retried.
    Denied { status: u16 },
    /// Another 4xx: the request itself is wrong. Not retried.
    Rejected { status: u16 },
    /// 429 or 5xx after the whole attempt budget.
    Exhausted { status: u16, attempts: u32 },
    /// No response after the whole attempt budget.
    Lost { attempts: u32 },
    /// `curl` is not on this machine; nothing can be sent.
    Unavailable,
    /// A 2xx whose body was not a receipt.
    UnreadableReceipt,
    /// Stored state or the in-crate receipt confirmation failed.
    Sync(SyncError),
}

impl fmt::Display for SendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingEndpoint => write!(f, "{} is not set", ENDPOINT_ENV),
            Self::MissingCredential => write!(f, "{} is not set", GRANT_ENV),
            Self::UnusableCredential => {
                write!(f, "{} holds an empty or multi-line token", GRANT_ENV)
            }
            Self::TooManyEntries { count, limit } => {
                write!(f, "batch has {count} entries, limit is {limit}")
            }
            Self::BodyTooLarge { bytes, limit } => {
                write!(f, "batch body is {bytes} bytes, limit is {limit}")
            }
            Self::TooLarge { status } => {
                write!(f, "the server refused the body as too large: {status}")
            }
            Self::Denied { status } => write!(f, "the grant was refused: {status}"),
            Self::Rejected { status } => write!(f, "the batch was rejected: {status}"),
            Self::Exhausted { status, attempts } => {
                write!(f, "still answered {status} after {attempts} attempts")
            }
            Self::Lost { attempts } => {
                write!(f, "no response after {attempts} attempts")
            }
            Self::Unavailable => f.write_str("curl is not available on this machine"),
            Self::UnreadableReceipt => f.write_str("the answer was not a receipt"),
            Self::Sync(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SendError {}
