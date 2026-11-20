//! The hook path: one JSON event in, at most one queued hint out.
//!
//! Guarantees, in the order they matter:
//! - never opens, stats, hashes or parses the file a hint points at (path
//!   validation is purely lexical);
//! - never touches the network (this crate contains no network code);
//! - buffers at most [`MAX_EVENT_BYTES`] of stdin, and always reads the pipe to
//!   its end — a hook that exits early makes the *client* fail with `EPIPE`;
//! - every failure mode exits 0 with nothing queued (fail open), because a
//!   broken hook must never break the client's tool call.

use std::io::Read;

use crate::adapters::{self, Reject};
use crate::enrollment::Enrollment;
use crate::hint::{Client, HookHintV1};
use crate::json::Json;
use crate::queue::{Enqueue, HintSink, QueueError};
use crate::store::{Store, StoreError};

/// Upper bound on the event payload. Hook payloads are a few hundred bytes;
/// anything larger is not an event we understand.
pub const MAX_EVENT_BYTES: u64 = 64 * 1024;

/// What the hook did, for the caller to log (never to print on success).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A hint was accepted (added, coalesced, or dropped at capacity).
    Enqueued(Enqueue),
    /// The event was refused; nothing was queued.
    Ignored(Reject),
    /// The state directory could not be used; nothing was acknowledged.
    Unavailable(&'static str),
}

/// Validate one event and enqueue it.
pub fn handle(client: Client, input: &mut dyn Read, store: &Store) -> Outcome {
    // Read and drain stdin first, whatever happens next: the writer is the
    // client's tool call, and exiting before it finishes shows up there as
    // `EPIPE`.
    let event = read_event(input);
    let enrollment = match store.enrollment() {
        Ok(enrollment) => enrollment,
        Err(StoreError::MissingEnrollment) => return Outcome::Ignored(Reject::NotEnrolled),
        Err(_) => return Outcome::Unavailable("enrollment file unreadable"),
    };
    let Some(event) = event else {
        return Outcome::Ignored(Reject::Oversized);
    };
    let Some(parsed) = parse_event(&event) else {
        return Outcome::Ignored(Reject::Malformed);
    };
    match adapters::adapt(client, &parsed, &enrollment.prefixes()) {
        Ok(adapted) => enqueue(store, &hinted(&enrollment, client, adapted)),
        Err(reason) => Outcome::Ignored(reason),
    }
}

fn hinted(enrollment: &Enrollment, client: Client, adapted: adapters::Adapted) -> HookHintV1 {
    HookHintV1 {
        enrollment_id: enrollment.enrollment_id.clone(),
        client,
        adapter_version: Client::ADAPTER_VERSION.to_string(),
        kind: adapted.kind,
        correlation_id: adapted.correlation_id,
    }
}

fn enqueue(store: &Store, hint: &HookHintV1) -> Outcome {
    let mut queue = match store.queue() {
        Ok(queue) => queue,
        Err(error) => return Outcome::Unavailable(queue_problem(&error)),
    };
    write_hint(&mut queue, hint)
}

/// Enqueue through the [`HintSink`] seam, so a transactional backend can land
/// later without touching the hook.
fn write_hint(sink: &mut dyn HintSink, hint: &HookHintV1) -> Outcome {
    match sink.enqueue(hint) {
        Ok(outcome) => Outcome::Enqueued(outcome),
        Err(error) => Outcome::Unavailable(queue_problem(&error)),
    }
}

fn queue_problem(error: &QueueError) -> &'static str {
    match error {
        QueueError::Io(_) => "queue io error",
        QueueError::Corrupt(_) => "queue file corrupt",
    }
}

/// Read one bounded event, then consume the rest of stdin without keeping it.
///
/// The buffer never grows past `MAX_EVENT_BYTES` + 1: anything longer is
/// refused, but the remainder of the pipe is still read to the end so the
/// writer never sees a broken pipe.
fn read_event(input: &mut dyn Read) -> Option<String> {
    let mut bytes = Vec::new();
    let read = {
        let mut limited = (&mut *input).take(MAX_EVENT_BYTES + 1);
        limited.read_to_end(&mut bytes)
    };
    drain(input);
    read.ok()?;
    if bytes.len() as u64 > MAX_EVENT_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Read the rest of stdin into the void, so the writer can finish.
pub fn drain(input: &mut dyn Read) {
    let _ = std::io::copy(input, &mut std::io::sink());
}

fn parse_event(text: &str) -> Option<Json> {
    crate::json::parse(text).ok()
}
