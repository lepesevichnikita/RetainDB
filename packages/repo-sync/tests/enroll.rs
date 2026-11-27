//! Enrollment: what `status` and the hook trust as "the root".
//!
//! The enrollment id is generated locally; no client event can set it.

mod support;

#[test]
fn enroll_records_the_canonical_root() {
    // A symlinked or relative root must be stored in its canonical form so
    // later subcommands compare like with like.
    let harness = support::Harness::new();
    let run = harness.run(&["enroll", "--root", &harness.root_text()], "");
    assert_eq!(run.code, 0, "enroll should succeed: {}", run.stdout);
    let record = harness.store.enrollment().expect("enrollment is stored");
    assert_eq!(record.root, harness.root.canonicalize().expect("canonical"));
}

#[test]
fn enroll_rejects_a_relative_root() {
    // `--root` must be absolute; guessing a base directory hides mistakes.
    let harness = support::Harness::new();
    let run = harness.run(&["enroll", "--root", "packages/repo-sync"], "");
    assert_eq!(
        run.code, 1,
        "relative root must fail with an operation error"
    );
    assert!(harness.store.enrollment().is_err(), "nothing is enrolled");
}

#[test]
fn enroll_rejects_a_missing_root() {
    // A typo in the path must not create an enrollment pointing nowhere.
    let harness = support::Harness::new();
    let missing = harness.root.join("does-not-exist");
    let run = harness.run(&["enroll", "--root", &missing.to_string_lossy()], "");
    assert_eq!(run.code, 1);
    assert!(harness.store.enrollment().is_err());
}

#[test]
fn enroll_creates_the_state_directory() {
    // First run on a clean machine: the state dir does not exist yet.
    let harness = support::Harness::new();
    let nested = harness.store.dir().join("deep/state");
    let store = retaindb_repo::store::Store::open(&nested);
    let run = support::run_in(&store, &["enroll", "--root", &harness.root_text()], "");
    assert_eq!(run.code, 0, "enroll writes through nested state dirs");
    assert!(nested.join("enrollment.json").is_file());
}

#[test]
fn enrollment_id_is_stable_between_reads() {
    // Every queued hint carries this id; it must not drift per process.
    let harness = support::Harness::enrolled();
    let first = harness.store.enrollment().expect("enrolled").enrollment_id;
    let second = retaindb_repo::store::Store::open(harness.store.dir())
        .enrollment()
        .expect("re-read")
        .enrollment_id;
    assert_eq!(first, second);
    assert!(!first.is_empty());
}

#[test]
fn unknown_subcommand_exits_two() {
    // Usage errors are distinct from operation failures for scripts.
    let harness = support::Harness::enrolled();
    let run = harness.run(&["frobnicate"], "");
    assert_eq!(run.code, 2);
}

#[test]
fn unknown_flag_exits_two() {
    // A typo like --roots must not silently enroll something else.
    let harness = support::Harness::new();
    let run = harness.run(&["enroll", "--roots", &harness.root_text()], "");
    assert_eq!(run.code, 2);
}
