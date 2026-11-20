//! The hook accept path: one validated event becomes exactly one metadata hint.

mod support;

#[test]
fn claude_read_enqueues_exactly_one_hint() {
    // A successful Claude `Read` of a repo file is the core signal.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_01");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 1, "one read is one hint");
    let hint = support::hint_for(&harness.queue(), "src/main.rs");
    assert_eq!(hint.kind, "file_read");
    assert_eq!(hint.client, "claude");
    assert_eq!(hint.correlation_id.as_deref(), Some("toolu_01"));
    assert_eq!(
        hint.enrollment_id,
        harness.store.enrollment_id().expect("enrolled")
    );
}

#[test]
fn claude_absolute_path_is_stored_relative_to_the_root() {
    // Claude sends absolute paths; the queue must hold repo-relative ones.
    let harness = support::Harness::enrolled();
    let absolute = harness.path("packages/sync/src/lib.rs");
    let event = support::claude_read_event(&harness.root, &absolute.to_string_lossy(), "toolu_02");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    let hint = support::hint_for(&harness.queue(), "packages/sync/src/lib.rs");
    assert_eq!(hint.path.as_deref(), Some("packages/sync/src/lib.rs"));
}

#[test]
fn hermes_read_enqueues_the_relative_path() {
    // Hermes already reports a repo-relative path for `read_file`.
    let harness = support::Harness::enrolled();
    let event = support::hermes_read_event(&harness.root, "packages/repo-sync/README.md");
    let run = harness.run(&["hook", "--client", "hermes"], &event);
    assert_eq!(run.code, 0);
    assert_eq!(harness.queue_depth(), 1);
    let hint = support::hint_for(&harness.queue(), "packages/repo-sync/README.md");
    assert_eq!(hint.kind, "file_read");
    assert_eq!(hint.client, "hermes");
}

#[test]
fn hermes_encoded_result_is_never_stored() {
    // `extra.result` is an opaque body; only metadata may reach the queue.
    let harness = support::Harness::enrolled();
    let event = support::hermes_read_event(&harness.root, "src/main.rs");
    harness.run(&["hook", "--client", "hermes"], &event);
    let queue_text =
        String::from_utf8_lossy(&support::read_bytes(&harness.state_file("queue.json")))
            .into_owned();
    assert!(
        !queue_text.contains("BASE64-ENCODED-BODY"),
        "queue held the encoded body: {queue_text}"
    );
}

#[test]
fn hook_prints_nothing_on_success() {
    // Hook output goes to the client's prompt; silence is part of the contract.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_03");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    assert!(run.stdout.is_empty(), "stdout was {:?}", run.stdout);
}

#[test]
fn queued_hint_survives_a_fresh_state_handle() {
    // The hint is on disk, not in the process: the next sync reads it back.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_04");
    harness.run(&["hook", "--client", "claude"], &event);
    let reopened = retaindb_repo::store::Store::open(harness.store.dir());
    let queue = reopened.queue().expect("queue readable");
    assert_eq!(queue.depth(), 1);
    assert_eq!(queue.hints()[0].path.as_deref(), Some("src/main.rs"));
}

#[test]
fn every_hint_carries_the_adapter_version() {
    // The server needs to know which adapter dialect produced a hint.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_05");
    harness.run(&["hook", "--client", "claude"], &event);
    let hint = support::hint_for(&harness.queue(), "src/main.rs");
    assert_eq!(hint.adapter_version, "1");
}

#[test]
fn hook_enqueues_a_unicode_relative_path() {
    // A path in a non-ASCII directory is still a normal repo path.
    let harness = support::Harness::enrolled();
    let event = support::claude_read_event(&harness.root, "src/тест/файл.rs", "toolu_uni");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0);
    let hint = support::hint_for(&harness.queue(), "src/тест/файл.rs");
    assert_eq!(hint.kind, "file_read");
}

#[test]
fn hook_without_enrollment_queues_nothing() {
    // An unenrolled state dir has no trusted id, so there is nothing to stamp.
    let harness = support::Harness::new();
    let event = support::claude_read_event(&harness.root, "src/main.rs", "toolu_06");
    let run = harness.run(&["hook", "--client", "claude"], &event);
    assert_eq!(run.code, 0, "hook still fails open");
    assert_eq!(harness.queue_depth(), 0);
}
