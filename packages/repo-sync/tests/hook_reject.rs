//! The hook fail-open contract: every unusable event exits 0 and queues
//! nothing. A hook that fails loudly would break the client's tool call.

mod support;

#[test]
fn absolute_path_outside_the_root_fails_open() {
    // `/etc/passwd` is not a repository path, whatever the client claims.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "/etc/passwd", "toolu_1");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn traversal_path_fails_open() {
    // `..` would let an event name files outside the enrollment root.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "../../etc/passwd", "toolu_2");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn traversal_inside_an_absolute_path_fails_open() {
    // Prefixing the root does not make `..` safe.
    let harness = support::Harness::enrolled();
    let escape = format!("{}/../outside.txt", harness.root_text());
    let event = support::claude_read_event(&harness.root, &escape, "toolu_3");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn unknown_schema_version_fails_open() {
    // Version 2 may mean something this build cannot validate.
    let harness = support::Harness::enrolled();
    let event =
        r#"{"schema_version":2,"tool_name":"Read","tool_input":{"file_path":"src/main.rs"}}"#;
    let run = harness.run(&["hook", "--client", "claude"], event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn unknown_client_fails_open() {
    // Misconfigured hook command: the client must not be blocked by it.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_4");
    let run = harness.run(&["hook", "--client", "emacs"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn missing_client_fails_open() {
    // A broken hook registration still must not block the tool call.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_5");
    let run = harness.run(&["hook"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn oversized_input_fails_open() {
    // The event reader is bounded: 80 KiB is not an event we accept.
    let harness = support::Harness::enrolled();
    let padding = "x".repeat(80 * 1024);
    let event = format!(
        r#"{{"schema_version":1,"tool_name":"Read","tool_input":{{"file_path":"src/main.rs"}},"cwd":"{}","pad":"{padding}"}}"#,
        harness.root.display()
    );
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0, "oversized events queue nothing");
}

#[test]
fn oversized_path_fails_open() {
    // A 5 KB "path" is not a repository path; accepting it would bloat
    // queue.json, which is rewritten in full on every event.
    let harness = support::Harness::enrolled();
    let long = format!("src/{}.rs", "x".repeat(5000));
    let event = support::claude_read_event(&harness.root, &long, "toolu_long");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
    assert!(
        !harness.state_file("queue.json").exists(),
        "a refused event writes no queue file"
    );
}

#[test]
fn oversized_correlation_id_fails_open() {
    // The correlation id is an opaque tool-call id, a few dozen bytes at most.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", &"t".repeat(300));
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
    assert!(!harness.state_file("queue.json").exists());
}

#[test]
fn malformed_json_fails_open() {
    // A truncated or non-JSON stdin read must not crash or queue.
    let harness = support::Harness::enrolled();
    let run = harness.run(&["hook", "--client", "claude"], "{\"tool_name\": ");
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn empty_stdin_fails_open() {
    // No event at all is still not an error for the client.
    let harness = support::Harness::enrolled();
    let run = harness.run(&["hook", "--client", "claude"], "");
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn non_read_tool_fails_open() {
    // Bash or Edit calls are not reads and carry no read path.
    let harness = support::Harness::enrolled();
    let event = r#"{"schema_version":1,"tool_name":"Bash","tool_input":{"command":"ls"}}"#;
    let run = harness.run(&["hook", "--client", "claude"], event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn hermes_failed_read_fails_open() {
    // A failed read did not happen, so it is not a read signal.
    let harness = support::Harness::enrolled();
    let event = support::hermes_failed_read_event(&harness.root, "src/main.rs");
    let run = harness.run(&["hook", "--client", "hermes"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 0);
}

#[test]
fn codex_file_read_fails_open() {
    // Codex has no trustworthy per-file read event; the adapter must not invent
    // one, even when the payload looks like a read.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_6");
    let run = harness.run(&["hook", "--client", "codex"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(
        harness.queue_depth(),
        0,
        "codex must never queue a file_read"
    );
}

#[test]
fn codex_reconcile_is_accepted() {
    // `SessionStart`/`Stop` are the only Codex signals: ask for a reconcile.
    let harness = support::Harness::enrolled();
    let event = support::codex_lifecycle_event("SessionStart");
    let run = harness.run(&["hook", "--client", "codex"], &event);
    assert_eq!(run.code, 0);
    let queue = harness.queue();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].kind, "reconcile");
    assert_eq!(queue[0].client, "codex");
    assert_eq!(queue[0].path, None);
}

#[test]
fn hook_never_opens_the_target_file() {
    // `ghost.rs` does not exist; if the hook opened it, this would fail open.
    let harness = support::Harness::enrolled();
    let ghost = harness.path("src/ghost.rs");
    assert!(!ghost.exists(), "fixture must not exist");
    let event = support::claude_read_event(&harness.root, &ghost.to_string_lossy(), "toolu_7");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(
        harness.queue_depth(),
        1,
        "validation must not need the file"
    );
    assert!(!ghost.exists(), "the hook must not create the path either");
}

#[test]
fn rejected_event_leaves_no_partial_state() {
    // A refused event must not touch the state directory at all.
    let harness = support::Harness::enrolled();
    let before = std::fs::read(harness.state_file("queue.json")).ok();
    let event = support::claude_read_event(&harness.root, "/etc/passwd", "toolu_8");
    harness.run(&["hook", "--client", "claude"], &event);
    let after = std::fs::read(harness.state_file("queue.json")).ok();
    assert_eq!(before, after, "queue file untouched by a rejected event");
}
