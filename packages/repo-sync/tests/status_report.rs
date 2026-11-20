//! `status`: the five facts an operator needs, plus the generation counter.
//! The receipt watermark only moves when a confirmation says so.

mod support;

use retaindb_repo::sync;

#[test]
fn status_prints_every_required_field() {
    // Scripts parse these lines, so the keys and values must be exact.
    let harness = support::Harness::git_repo();
    harness.sync();
    let out = harness.status();
    assert_eq!(
        out["root"],
        harness
            .root
            .canonicalize()
            .expect("canonical")
            .to_string_lossy()
    );
    assert_eq!(out["queue_depth"], "0");
    assert_eq!(out["overflow"], "false");
    assert_eq!(out["last_confirmed_generation"], "0");
    assert_eq!(out["pending"], "1");
    assert_eq!(out["generation"], "1");
}

#[test]
fn status_reports_queue_depth_and_overflow() {
    // Queue pressure is visible without inspecting state files by hand.
    let harness = support::Harness::enrolled();
    harness.run(
        &["hook", "--client", "claude"],
        &support::claude_read_event(&harness.root, "src/main.rs", "toolu_1"),
    );
    let out = harness.status();
    assert_eq!(out["queue_depth"], "1");
    assert_eq!(out["overflow"], "false");
}

#[test]
fn watermark_stays_zero_until_a_receipt_is_confirmed() {
    // A sync alone never confirms anything: no receipt, no watermark movement.
    let harness = support::Harness::git_repo();
    let sync_out = harness.sync();
    assert_eq!(harness.status()["last_confirmed_generation"], "0");
    let generation = sync_out["generation"].parse::<u64>().expect("generation");
    sync::confirm_receipt(&harness.store, generation).expect("confirm");
    let after = harness.status();
    assert_eq!(after["last_confirmed_generation"], generation.to_string());
    assert_eq!(after["pending"], "0");
}

#[test]
fn confirming_an_unknown_generation_is_refused() {
    // A receipt for a batch we never produced must not move the watermark.
    let harness = support::Harness::git_repo();
    harness.sync();
    assert!(sync::confirm_receipt(&harness.store, 99).is_err());
    assert_eq!(harness.status()["last_confirmed_generation"], "0");
}

#[test]
fn status_for_a_foreign_root_fails() {
    // Reporting another repository's state would be a lie.
    let harness = support::Harness::enrolled();
    let other = support::Harness::new();
    let run = harness.run(&["status", "--root", &other.root_text()], "");
    assert_eq!(run.code, 1);
}

#[test]
fn status_before_enrollment_fails() {
    // Without an enrollment there is no root to report.
    let harness = support::Harness::new();
    let run = harness.run(&["status", "--root", &harness.root_text()], "");
    assert_eq!(run.code, 1);
}
