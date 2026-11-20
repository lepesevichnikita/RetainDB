//! Queue shaping: duplicates coalesce per enrollment, and the queue is bounded.

mod support;

#[test]
fn duplicate_path_for_the_same_enrollment_coalesces() {
    // The same file read twice in one session is one pending hint.
    let harness = support::Harness::enrolled();
    let first = support::claude_read_event(&harness.root, "src/main.rs", "toolu_a");
    let second = support::claude_read_event(&harness.root, "src/main.rs", "toolu_b");
    harness.run(&["hook", "--client", "claude"], &first);
    harness.run(&["hook", "--client", "claude"], &second);
    assert_eq!(harness.queue_depth(), 1);
    assert_eq!(harness.queue()[0].path.as_deref(), Some("src/main.rs"));
}

#[test]
fn coalescing_keeps_the_latest_correlation_id() {
    // The newest tool call is the one worth correlating with.
    let harness = support::Harness::enrolled();
    let first = support::claude_read_event(&harness.root, "src/main.rs", "toolu_old");
    let second = support::claude_read_event(&harness.root, "src/main.rs", "toolu_new");
    harness.run(&["hook", "--client", "claude"], &first);
    harness.run(&["hook", "--client", "claude"], &second);
    assert_eq!(
        harness.queue()[0].correlation_id.as_deref(),
        Some("toolu_new")
    );
}

#[test]
fn different_paths_are_kept_separately() {
    // Coalescing must not collapse distinct files.
    let harness = support::Harness::enrolled();
    harness.run(
        &["hook", "--client", "claude"],
        &support::claude_read_event(&harness.root, "src/main.rs", "toolu_1"),
    );
    harness.run(
        &["hook", "--client", "claude"],
        &support::claude_read_event(&harness.root, "src/lib.rs", "toolu_2"),
    );
    assert_eq!(harness.queue_depth(), 2);
}

#[test]
fn reconcile_hints_coalesce_to_one_per_enrollment() {
    // A reconcile is "look at the tree", so repeats collapse to one request.
    let harness = support::Harness::enrolled();
    harness.run(
        &["hook", "--client", "codex"],
        &support::codex_lifecycle_event("SessionStart"),
    );
    harness.run(
        &["hook", "--client", "codex"],
        &support::codex_lifecycle_event("Stop"),
    );
    assert_eq!(harness.queue_depth(), 1);
    assert_eq!(harness.queue()[0].kind, "reconcile");
}

#[test]
fn overflow_sets_the_flag_and_caps_the_queue() {
    // An unbounded queue would grow a state file without limit while offline.
    let harness = support::Harness::enrolled();
    let cap = retaindb_repo::queue::MAX_HINTS;
    for index in 0..(cap + 10) {
        let path = format!("src/file_{index}.rs");
        let event = support::claude_read_event(&harness.root, &path, "toolu");
        harness.run(&["hook", "--client", "claude"], &event);
    }
    let queue = harness.store.queue().expect("queue readable");
    assert_eq!(queue.depth(), cap, "queue stops growing at the cap");
    assert!(queue.overflow(), "overflow flag is set");
}

#[test]
fn opening_a_planted_oversized_queue_truncates_it() {
    // A queue file can outlive the cap it was written under. Open must trim it
    // and flag the drop, or every later save rewrites 300 records.
    let harness = support::Harness::enrolled();
    let cap = retaindb_repo::queue::MAX_HINTS;
    let enrollment_id = harness.store.enrollment_id().expect("enrolled");
    let hints: Vec<String> = (0..cap + 44)
        .map(|index| {
            format!(
                r#"{{"enrollment_id":"{enrollment_id}","client":"claude","adapter_version":"1","kind":"file_read","path":"src/file_{index}.rs","correlation_id":null,"sequence":{index}}}"#
            )
        })
        .collect();
    std::fs::write(
        harness.state_file("queue.json"),
        format!(
            r#"{{"enrollment_id":"{enrollment_id}","overflow":false,"hints":[{}]}}"#,
            hints.join(",")
        ),
    )
    .expect("plant queue");
    let queue = harness.store.queue().expect("queue opens");
    assert_eq!(queue.depth(), cap, "open trims to the cap");
    assert!(queue.overflow(), "the dropped hints are recorded");
    let event = support::claude_read_event(&harness.root, "src/new.rs", "toolu_new");
    harness.run(&["hook", "--client", "claude"], &event);
    let text =
        String::from_utf8(support::read_bytes(&harness.state_file("queue.json"))).expect("utf-8");
    assert_eq!(
        text.matches("\"sequence\"").count(),
        cap,
        "the rewritten file holds the cap, not the planted 300"
    );
    let reopened = harness.store.queue().expect("queue reopens");
    assert_eq!(reopened.depth(), cap);
    assert!(reopened.overflow());
}

#[test]
fn coalescing_still_works_when_the_queue_is_full() {
    // At capacity, an already-queued path must refresh, not drop.
    let harness = support::Harness::enrolled();
    let cap = retaindb_repo::queue::MAX_HINTS;
    for index in 0..cap {
        let path = format!("src/file_{index}.rs");
        let event = support::claude_read_event(&harness.root, &path, "toolu_first");
        harness.run(&["hook", "--client", "claude"], &event);
    }
    let repeat = support::claude_read_event(&harness.root, "src/file_0.rs", "toolu_second");
    harness.run(&["hook", "--client", "claude"], &repeat);
    let queue = harness.store.queue().expect("queue readable");
    assert_eq!(queue.depth(), cap);
    assert!(!queue.overflow(), "a refresh is not an overflow");
    assert_eq!(
        support::hint_for(queue.hints(), "src/file_0.rs")
            .correlation_id
            .as_deref(),
        Some("toolu_second")
    );
}
