//! End-to-end: the real binary, a real process, a real exit code.
//! The library tests drive `cli::run`; these prove the shipped executable wires
//! stdin, stdout and the state directory the same way.

mod support;

use std::io::Write;
use std::process::{Command, Stdio};

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_retaindb-repo"))
}

#[test]
fn enroll_then_status_through_the_binary() {
    // The two commands an operator runs first, in one process each.
    let harness = support::Harness::new();
    let enroll = binary()
        .args(["enroll", "--root", &harness.root_text()])
        .env("RETAINDB_REPO_STATE_DIR", harness.store.dir())
        .output()
        .expect("binary runs");
    assert!(enroll.status.success(), "enroll exit 0");
    assert!(String::from_utf8_lossy(&enroll.stdout).contains("enrollment_id="));

    let status = binary()
        .args(["status", "--root", &harness.root_text()])
        .env("RETAINDB_REPO_STATE_DIR", harness.store.dir())
        .output()
        .expect("binary runs");
    assert!(status.status.success());
    let text = String::from_utf8_lossy(&status.stdout);
    assert!(text.contains("queue_depth=0"));
    assert!(text.contains("last_confirmed_generation=0"));
}

#[test]
fn hook_reads_stdin_and_exits_zero_through_the_binary() {
    // A hook is a pipe: JSON on stdin, nothing on stdout, status 0.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_bin");
    let mut child = binary()
        .args(["hook", "--client", "claude"])
        .env("RETAINDB_REPO_STATE_DIR", harness.store.dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("binary runs");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(event.as_bytes())
        .expect("write event");
    let output = child.wait_with_output().expect("finishes");
    assert_eq!(output.status.code(), Some(0));
    assert!(output.stdout.is_empty(), "hook prints nothing on success");
    assert_eq!(harness.queue_depth(), 1);
}

#[test]
fn hook_with_broken_stdin_exits_zero_through_the_binary() {
    // Even total garbage must not make the binary fail the client.
    let harness = support::Harness::enrolled();
    let mut child = binary()
        .args(["hook", "--client", "claude"])
        .env("RETAINDB_REPO_STATE_DIR", harness.store.dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("binary runs");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(b"not json at all")
        .expect("write garbage");
    let output = child.wait_with_output().expect("finishes");
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(harness.queue_depth(), 0);
}

/// A payload far over the hook's 64 KiB event limit: ~900 KB, the size that
/// used to make the caller fail with `BrokenPipe`.
fn oversized_payload() -> String {
    format!(
        r#"{{"schema_version":1,"tool_name":"read_file","tool_input":{{"path":"src/main.rs"}},"cwd":"/tmp","extra":{{"status":"success","result":{{"body":"{}"}}}}}}"#,
        "x".repeat(900 * 1024)
    )
}

/// Spawn the hook, write the whole payload, and return the child's output.
/// `write_all` is the assertion that matters: a hook that exits before the
/// payload is consumed makes its *caller* fail, even though the hook exits 0.
fn write_hook_stdin(
    harness: &support::Harness,
    args: &[&str],
    payload: &str,
) -> std::process::Output {
    let mut child = binary()
        .args(args)
        .env("RETAINDB_REPO_STATE_DIR", harness.store.dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("binary runs");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(payload.as_bytes())
        .expect("the hook must consume the whole payload, or the client sees EPIPE");
    child.wait_with_output().expect("finishes")
}

#[test]
fn oversized_hook_payload_is_drained_without_an_epipe() {
    // The hook refuses the event, but must still read the pipe to the end.
    let harness = support::Harness::enrolled();
    let output = write_hook_stdin(
        &harness,
        &["hook", "--client", "hermes"],
        &oversized_payload(),
    );
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(harness.queue_depth(), 0, "oversized events queue nothing");
}

#[test]
fn not_enrolled_hook_still_drains_stdin() {
    // No enrollment is an early return; the caller's write must still finish.
    let harness = support::Harness::new();
    let output = write_hook_stdin(
        &harness,
        &["hook", "--client", "claude"],
        &oversized_payload(),
    );
    assert_eq!(output.status.code(), Some(0));
    assert!(
        harness.store.enrollment_id().is_none(),
        "still not enrolled"
    );
}

#[test]
fn unknown_client_hook_still_drains_stdin() {
    // A broken `--client` value is another early return before the event read.
    let harness = support::Harness::enrolled();
    let output = write_hook_stdin(
        &harness,
        &["hook", "--client", "emacs"],
        &oversized_payload(),
    );
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn sync_through_the_binary_reports_a_generation() {
    // One reconcile pass over a real Git work tree.
    let harness = support::Harness::git_repo();
    let output = binary()
        .args(["sync", "--root", &harness.root_text()])
        .env("RETAINDB_REPO_STATE_DIR", harness.store.dir())
        .output()
        .expect("binary runs");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("generation=1"), "stdout was {text}");
    assert!(text.contains("upserts=1"), "stdout was {text}");
}
