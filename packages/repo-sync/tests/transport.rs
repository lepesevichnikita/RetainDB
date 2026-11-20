//! The outbound batch transport: bounded before it leaves, classified by
//! status, retried only where a retry can help, and never echoing the scoped
//! credential.
//!
//! Every test drives the production entry point (`transport::deliver`) with the
//! fake transport, so no socket is opened and no `curl` runs.

mod support;

use std::cell::RefCell;
use std::collections::{BTreeSet, VecDeque};

use retaindb_repo::json;
use retaindb_repo::sync_state::{ChangeKind, PendingChange, SyncState};
use retaindb_repo::transport::{
    deliver, Credential, Endpoint, Limits, Lost, Receipt, Reply, Request, SendError, Transport,
};

/// The token a real deployment would read from the environment.
const TOKEN: &str = "grant-7f3a-do-not-leak";

fn endpoint() -> Endpoint {
    Endpoint {
        url: "https://retain.example.test/v1/repo-index/batches".to_string(),
        credential: Credential::parse(TOKEN).expect("a usable token"),
    }
}

/// Retry budget small enough to assert on, with no waiting between attempts.
fn limits() -> Limits {
    Limits {
        max_wire_bytes: 64 * 1024,
        max_entries: 16,
        max_attempts: 3,
        backoff_ms: 0,
    }
}

fn answered(status: u16) -> Reply {
    Reply::Status {
        status,
        body: String::new(),
    }
}

fn receipted(generation: u64) -> Reply {
    Reply::Status {
        status: 200,
        body: format!(r#"{{"generation":{generation}}}"#),
    }
}

/// A stored generation with `paths` pending and no receipt yet.
fn planted(harness: &support::Harness, generation: u64, paths: &[&str]) {
    let mut state = SyncState {
        generation,
        ..SyncState::default()
    };
    for path in paths {
        state.pending.insert(
            (*path).to_string(),
            PendingChange {
                kind: ChangeKind::Upsert,
                digest: Some("a".repeat(64)),
                generation,
            },
        );
    }
    harness.store.save_sync_state(&state).expect("state saved");
}

fn watermark(harness: &support::Harness) -> u64 {
    harness
        .store
        .sync_state()
        .expect("state readable")
        .watermark
}

/// A scripted server: records every request and applies each part once, so a
/// retry of the same part is visible as one applied part and two requests.
struct FakeTransport {
    replies: RefCell<VecDeque<Reply>>,
    requests: RefCell<Vec<Request>>,
    applied: RefCell<BTreeSet<(u64, u64)>>,
    lose_first: bool,
}

impl FakeTransport {
    fn answering(replies: Vec<Reply>) -> Self {
        Self {
            replies: RefCell::new(replies.into()),
            requests: RefCell::new(Vec::new()),
            applied: RefCell::new(BTreeSet::new()),
            lose_first: false,
        }
    }

    /// The first attempt is applied by the "server" and its answer is lost.
    fn losing_first(replies: Vec<Reply>) -> Self {
        Self {
            lose_first: true,
            ..Self::answering(replies)
        }
    }

    fn calls(&self) -> usize {
        self.requests.borrow().len()
    }

    fn requests(&self) -> Vec<Request> {
        self.requests.borrow().clone()
    }

    fn applied_parts(&self) -> usize {
        self.applied.borrow().len()
    }
}

impl Transport for FakeTransport {
    fn send(&self, request: &Request) -> Reply {
        self.requests.borrow_mut().push(request.clone());
        if let Some(part) = part_of(&request.body) {
            self.applied.borrow_mut().insert(part);
        }
        if self.lose_first && self.calls() == 1 {
            return Reply::Lost(Lost::Connection);
        }
        let answer = self.replies.borrow_mut().pop_front();
        answer.expect("the transport script ran out of answers")
    }
}

/// `(generation, part_no)` from a batch body: what the server deduplicates on.
fn part_of(body: &str) -> Option<(u64, u64)> {
    let value = json::parse(body).ok()?;
    Some((
        value.get("generation")?.as_u64()?,
        value.get("part_no")?.as_u64()?,
    ))
}

#[test]
fn success_advances_the_watermark_to_the_receipted_value() {
    // A parsed receipt is the only thing that may move the watermark.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs", "src/lib.rs"]);
    let transport = FakeTransport::answering(vec![receipted(3)]);
    let delivered = deliver(&harness.store, &transport, &endpoint(), &limits()).expect("delivered");
    assert_eq!(delivered, Some(Receipt { generation: 3 }));
    assert_eq!(watermark(&harness), 3, "the watermark follows the receipt");
    assert_eq!(
        harness.store.sync_state().expect("state").pending_count(),
        0,
        "a confirmed generation has nothing pending"
    );
}

#[test]
fn an_empty_pending_set_sends_nothing() {
    // A clean tree must not produce a request, let alone a receipt.
    let harness = support::Harness::enrolled();
    let transport = FakeTransport::answering(vec![receipted(1)]);
    assert_eq!(
        deliver(&harness.store, &transport, &endpoint(), &limits()).expect("no work"),
        None
    );
    assert_eq!(transport.calls(), 0);
}

#[test]
fn a_413_is_classified_and_is_not_retried() {
    // The server already said the body is too large; the same body cannot shrink.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs"]);
    let transport = FakeTransport::answering(vec![answered(413); 3]);
    let error =
        deliver(&harness.store, &transport, &endpoint(), &limits()).expect_err("413 is a failure");
    assert!(
        matches!(error, SendError::TooLarge { status: 413 }),
        "{error}"
    );
    assert_eq!(transport.calls(), 1, "the same body is not resent");
    assert_eq!(watermark(&harness), 0);
}

#[test]
fn a_429_retries_a_bounded_number_of_times_then_reports_failure() {
    // Retrying a rate limiter forever turns one slow batch into a hammer.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs"]);
    let transport = FakeTransport::answering(vec![answered(429); 3]);
    let error = deliver(&harness.store, &transport, &endpoint(), &limits())
        .expect_err("429 exhausts the budget");
    assert!(
        matches!(
            error,
            SendError::Exhausted {
                status: 429,
                attempts: 3
            }
        ),
        "{error}"
    );
    assert_eq!(transport.calls(), 3, "exactly the bounded attempt count");
    assert_eq!(
        watermark(&harness),
        0,
        "a refusal never advances the watermark"
    );
}

#[test]
fn a_5xx_is_retried_and_then_succeeds() {
    // A server-side failure is worth one more attempt.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs"]);
    let transport = FakeTransport::answering(vec![answered(503), receipted(3)]);
    let delivered = deliver(&harness.store, &transport, &endpoint(), &limits()).expect("delivered");
    assert_eq!(delivered, Some(Receipt { generation: 3 }));
    assert_eq!(transport.calls(), 2);
    assert_eq!(watermark(&harness), 3);
}

#[test]
fn a_lost_response_is_retried_and_the_duplicate_is_not_counted_twice() {
    // The first attempt reaches the server but its answer is lost, so the retry
    // must resend the same part number instead of opening a new one.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs"]);
    let transport = FakeTransport::losing_first(vec![receipted(3)]);
    let delivered = deliver(&harness.store, &transport, &endpoint(), &limits()).expect("delivered");
    assert_eq!(delivered, Some(Receipt { generation: 3 }));
    assert_eq!(transport.calls(), 2);
    let requests = transport.requests();
    assert_eq!(requests[0].url, requests[1].url);
    assert_eq!(
        requests[0].body, requests[1].body,
        "the retry resends the identical part"
    );
    assert_eq!(transport.applied_parts(), 1, "one part, applied once");
    assert_eq!(watermark(&harness), 3);
}

#[test]
fn a_lost_response_alone_never_moves_the_watermark() {
    // No receipt means no progress, however many attempts were made.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs"]);
    let transport = FakeTransport::answering(vec![Reply::Lost(Lost::Connection); 3]);
    let error = deliver(&harness.store, &transport, &endpoint(), &limits())
        .expect_err("no response is a failure");
    assert!(matches!(error, SendError::Lost { attempts: 3 }), "{error}");
    assert_eq!(transport.calls(), 3);
    assert_eq!(watermark(&harness), 0);
}

#[test]
fn a_401_is_not_retried() {
    // A refused grant does not heal by trying again.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs"]);
    let transport = FakeTransport::answering(vec![answered(401)]);
    let error =
        deliver(&harness.store, &transport, &endpoint(), &limits()).expect_err("401 is a failure");
    assert!(
        matches!(error, SendError::Denied { status: 401 }),
        "{error}"
    );
    assert_eq!(transport.calls(), 1);
    assert_eq!(watermark(&harness), 0);
}

#[test]
fn a_403_is_not_retried() {
    // A grant for another scope is just as permanent as a missing one.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs"]);
    let transport = FakeTransport::answering(vec![answered(403)]);
    let error =
        deliver(&harness.store, &transport, &endpoint(), &limits()).expect_err("403 is a failure");
    assert!(
        matches!(error, SendError::Denied { status: 403 }),
        "{error}"
    );
    assert_eq!(transport.calls(), 1);
}

#[test]
fn a_batch_over_the_entry_limit_is_refused_before_sending() {
    // Sending an oversized batch and learning from a 413 wastes the upload.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/a.rs", "src/b.rs", "src/c.rs"]);
    let transport = FakeTransport::answering(vec![receipted(3)]);
    let limits = Limits {
        max_entries: 2,
        ..limits()
    };
    let error =
        deliver(&harness.store, &transport, &endpoint(), &limits).expect_err("too many entries");
    assert!(
        matches!(error, SendError::TooManyEntries { count: 3, limit: 2 }),
        "{error}"
    );
    assert_eq!(transport.calls(), 0, "nothing reaches the transport");
}

#[test]
fn a_batch_over_the_wire_limit_is_refused_before_sending() {
    // The byte bound is the one the server would answer 413 to.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/a.rs"]);
    let transport = FakeTransport::answering(vec![receipted(3)]);
    let limits = Limits {
        max_wire_bytes: 64,
        ..limits()
    };
    let error =
        deliver(&harness.store, &transport, &endpoint(), &limits).expect_err("too many bytes");
    assert!(
        matches!(error, SendError::BodyTooLarge { limit: 64, .. }),
        "{error}"
    );
    assert_eq!(transport.calls(), 0, "nothing reaches the transport");
}

#[test]
fn the_credential_never_appears_in_any_error_string() {
    // Every failure class is exercised with the real token in flight.
    let harness = support::Harness::enrolled();
    planted(&harness, 3, &["src/main.rs"]);
    let scripts = vec![
        vec![answered(413)],
        vec![answered(401)],
        vec![answered(400)],
        vec![answered(429); 3],
        vec![Reply::Lost(Lost::Connection); 3],
        vec![Reply::Status {
            status: 200,
            body: "not a receipt".to_string(),
        }],
    ];
    for script in scripts {
        let transport = FakeTransport::answering(script);
        let error = deliver(&harness.store, &transport, &endpoint(), &limits())
            .expect_err("each script fails");
        let text = format!("{error} / {error:?}");
        assert!(!text.contains(TOKEN), "credential leaked: {text}");
        assert_eq!(
            transport.requests()[0].credential.expose(),
            TOKEN,
            "the token really was in the request"
        );
    }
    assert!(
        !format!("{:?}", endpoint()).contains(TOKEN),
        "the endpoint's Debug redacts the credential"
    );
}
