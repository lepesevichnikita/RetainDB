//! The outbound batch transport: bounded before it leaves, classified by
//! status, retried only where a retry can help, and never echoing the scoped
//! credential.
//!
//! Every test drives the production entry point (`transport::deliver`). Most of
//! them use the fake transport, so no socket is opened and no `curl` runs; the
//! loopback tests run the real `CurlTransport` against a local listener, so the
//! invocation itself (argv, stdin, status classification) is exercised too.

mod support;

use std::cell::RefCell;
use std::collections::{BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use retaindb_repo::json;
use retaindb_repo::sync_state::{ChangeKind, PendingChange, SyncState};
use retaindb_repo::transport::{
    command_for, deliver, Credential, CurlTransport, Endpoint, Limits, Lost, Receipt, Reply,
    Request, SendError, Transport, GRANT_HEADER,
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

/// One request as the loopback listener saw it.
#[derive(Debug)]
struct Seen {
    /// The scoped grant exactly as the server received it.
    grant: Option<String>,
    /// The raw body bytes, before any parsing.
    body: Vec<u8>,
}

/// A loopback listener that answers every request with the same status and body,
/// so the real `curl` invocation is exercised without touching a network.
struct Server {
    url: String,
    handler: thread::JoinHandle<Vec<Seen>>,
}

impl Server {
    /// The requests that arrived, once the client has stopped talking.
    fn seen(self) -> Vec<Seen> {
        self.handler.join().expect("the loopback server thread")
    }
}

/// Answer `status` with `answer` for every request until the client has been
/// quiet long enough that a retry would already have arrived. Counting the
/// requests that arrived is how a test sees the retry policy.
fn loopback(status: u16, answer: &'static str) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let port = listener.local_addr().expect("the bound address").port();
    listener.set_nonblocking(true).expect("a polling listener");
    let handler = thread::spawn(move || {
        let started = Instant::now();
        let mut quiet_since = started;
        let mut seen = Vec::new();
        loop {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    socket.set_nonblocking(false).expect("a blocking socket");
                    seen.push(read_request(&mut socket));
                    write_answer(&mut socket, status, answer);
                    quiet_since = Instant::now();
                }
                Err(_) => {
                    // A retry follows within milliseconds (the test limits have no
                    // backoff), so a longer silence is the end of the script.
                    let quiet = if seen.is_empty() {
                        Duration::from_secs(5)
                    } else {
                        Duration::from_millis(500)
                    };
                    if quiet_since.elapsed() > quiet || started.elapsed() > Duration::from_secs(20)
                    {
                        break;
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            }
        }
        seen
    });
    Server {
        url: format!("http://127.0.0.1:{port}/v1/repo-index/batches"),
        handler,
    }
}

/// Read one HTTP request: the named headers and the body bytes, unchanged.
fn read_request(socket: &mut TcpStream) -> Seen {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    while split_headers(&raw).is_none() {
        let read = socket.read(&mut chunk).expect("the request headers");
        assert!(read > 0, "the client closed before sending headers");
        raw.extend_from_slice(&chunk[..read]);
    }
    let split = split_headers(&raw).expect("a blank line after the headers");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let length: usize = header_of(&head, "content-length")
        .expect("a content-length")
        .parse()
        .expect("a numeric content-length");
    let mut body = raw[split..].to_vec();
    while body.len() < length {
        let read = socket.read(&mut chunk).expect("the request body");
        assert!(read > 0, "the client closed mid-body");
        body.extend_from_slice(&chunk[..read]);
    }
    Seen {
        grant: header_of(&head, GRANT_HEADER),
        body,
    }
}

/// Length of the request line and headers, including the blank line.
fn split_headers(raw: &[u8]) -> Option<usize> {
    raw.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| at + 4)
}

/// One header value by case-insensitive name; the value is not case-folded.
fn header_of(head: &str, name: &str) -> Option<String> {
    head.split("\r\n").skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then(|| value.trim().to_string())
    })
}

fn write_answer(socket: &mut TcpStream, status: u16, body: &str) {
    let answer = format!(
        "HTTP/1.1 {status} loopback\r\ncontent-type: application/json\r\n\
         content-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    socket
        .write_all(answer.as_bytes())
        .expect("the answer is written");
    socket.flush().expect("the answer is flushed");
}

/// The endpoint a loopback server answers on, with the production token.
fn loopback_endpoint(server: &Server) -> Endpoint {
    Endpoint {
        url: server.url.clone(),
        credential: Credential::parse(TOKEN).expect("a usable token"),
    }
}

#[test]
fn the_curl_command_line_carries_no_credential() {
    // `ps` and /proc/<pid>/cmdline show a child's arguments to other processes
    // for the whole request, so the grant must not be one of them.
    let request = Request {
        method: "POST",
        url: endpoint().url,
        body: r#"{"generation":3}"#.to_string(),
        credential: Credential::parse(TOKEN).expect("a usable token"),
    };
    let command = command_for(30, &request);
    let argv: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(argv.len() > 1, "the invocation carries arguments: {argv:?}");
    for arg in &argv {
        assert!(
            !arg.contains(TOKEN),
            "the credential is on the command line: {arg}"
        );
        assert!(
            !arg.to_ascii_lowercase().contains(GRANT_HEADER),
            "the grant header is on the command line: {arg}"
        );
    }
}

#[test]
fn the_loopback_success_path_returns_a_receipt_and_advances_the_watermark() {
    // The real curl invocation, not a fake: the grant still arrives, the receipt
    // still parses, and it is still the only thing that moves the watermark.
    let harness = support::Harness::enrolled();
    planted(&harness, 4, &["src/main.rs", "src/lib.rs"]);
    let server = loopback(200, r#"{"generation":4}"#);
    let delivered = deliver(
        &harness.store,
        &CurlTransport::default(),
        &loopback_endpoint(&server),
        &limits(),
    )
    .expect("delivered over loopback");
    assert_eq!(delivered, Some(Receipt { generation: 4 }));
    assert_eq!(watermark(&harness), 4, "the receipt moved the watermark");
    let seen = server.seen();
    assert_eq!(seen.len(), 1, "one generation, one request");
    assert_eq!(
        seen[0].grant.as_deref(),
        Some(TOKEN),
        "the grant reached the server without being an argument"
    );
}

#[test]
fn the_loopback_request_body_matches_the_fake_one_byte_for_byte() {
    // The invocation rewrite must not change a single byte of the request: the
    // loopback server receives exactly the body the fake transport received,
    // including a path that needs JSON escaping of a quote and a backslash.
    let harness = support::Harness::enrolled();
    planted(&harness, 4, &[r#"we"ird\name.rs"#, "src/main.rs"]);
    let fake = FakeTransport::answering(vec![answered(429); 3]);
    deliver(&harness.store, &fake, &endpoint(), &limits()).expect_err("429 is a failure");
    let expected = fake.requests()[0].body.clone();
    assert!(
        expected.contains(r#""we\"ird\\name.rs""#),
        "the planted path needs escaping: {expected}"
    );
    let server = loopback(200, r#"{"generation":4}"#);
    deliver(
        &harness.store,
        &CurlTransport::default(),
        &loopback_endpoint(&server),
        &limits(),
    )
    .expect("delivered over loopback");
    let seen = server.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        String::from_utf8(seen[0].body.clone()).expect("a UTF-8 body"),
        expected,
        "the request body is byte-identical to the fake one"
    );
}

#[test]
fn a_413_over_loopback_is_not_retried() {
    // A real 413 must still be final: the same body cannot shrink.
    let harness = support::Harness::enrolled();
    planted(&harness, 4, &["src/main.rs"]);
    let server = loopback(413, "");
    let error = deliver(
        &harness.store,
        &CurlTransport::default(),
        &loopback_endpoint(&server),
        &limits(),
    )
    .expect_err("413 is a failure");
    assert!(
        matches!(error, SendError::TooLarge { status: 413 }),
        "{error}"
    );
    assert_eq!(server.seen().len(), 1, "the same body is not resent");
    assert_eq!(watermark(&harness), 0);
}

#[test]
fn a_429_over_loopback_retries_only_the_attempt_budget() {
    // The real transport, not the fake, must stop at `max_attempts`.
    let harness = support::Harness::enrolled();
    planted(&harness, 4, &["src/main.rs"]);
    let server = loopback(429, "");
    let error = deliver(
        &harness.store,
        &CurlTransport::default(),
        &loopback_endpoint(&server),
        &limits(),
    )
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
    assert_eq!(server.seen().len(), 3, "exactly the bounded attempt count");
    assert_eq!(
        watermark(&harness),
        0,
        "a refusal never advances the watermark"
    );
}
