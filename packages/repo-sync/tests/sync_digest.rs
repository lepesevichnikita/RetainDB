//! Digest cache: changed files are rehashed, unrelated files are not, and the
//! periodic recheck of unchanged files is bounded per run.

mod support;

use retaindb_repo::sync::SyncOptions;

fn digest_of(text: &str) -> String {
    retaindb_repo::sha256::hex_digest(text.as_bytes())
}

#[test]
fn changed_file_gets_a_new_digest() {
    // A content change must be visible in the pending digest.
    let harness = support::Harness::git_repo();
    harness.write("src/change.rs", "fn one() {}\n");
    let first = harness.sync();
    assert_eq!(first["hashed"], "2", "README + change.rs are hashed once");
    harness.write("src/change.rs", "fn two() {}\n");
    harness.sync();
    assert_eq!(
        harness.state().pending["src/change.rs"].digest.as_deref(),
        Some(digest_of("fn two() {}\n").as_str())
    );
}

#[test]
fn unrelated_files_are_not_rehashed() {
    // Only the changed path goes through the hasher on the next run.
    let harness = support::Harness::git_repo();
    harness.write("src/a.rs", "fn a() {}\n");
    harness.write("src/b.rs", "fn b() {}\n");
    harness.sync();
    harness.write("src/b.rs", "fn b_changed() {}\n");
    let out = harness.sync();
    assert_eq!(out["hashed"], "1", "one file changed, one file hashed");
    assert_eq!(out["hashed_paths"], "src/b.rs");
}

#[test]
fn unchanged_file_keeps_its_recorded_digest() {
    // The cache is keyed by size + mtime; a hit reuses the digest.
    let harness = support::Harness::git_repo();
    harness.write("src/stable.rs", "fn stable() {}\n");
    harness.sync();
    let before = harness.state().files["src/stable.rs"].digest.clone();
    harness.sync();
    assert_eq!(harness.state().files["src/stable.rs"].digest, before);
}

#[test]
fn bounded_recheck_hashes_at_most_the_budget() {
    // With a 1-file budget, the rotation verifies one unchanged file per run.
    let harness = support::Harness::git_repo();
    harness.write("src/one.rs", "fn one() {}\n");
    harness.write("src/two.rs", "fn two() {}\n");
    let options = SyncOptions {
        recheck_budget: 1,
        recheck_age_generations: 0,
        ..SyncOptions::default()
    };
    harness.sync_with(&options).expect("first run");
    let second = harness.sync_with(&options).expect("second run");
    assert_eq!(second.hashed, 1, "exactly one recheck");
    let third = harness.sync_with(&options).expect("third run");
    assert_eq!(third.hashed, 1);
    assert_ne!(
        second.hashed_paths, third.hashed_paths,
        "the rotation moves to the next file instead of repeating"
    );
}

#[test]
fn a_recheck_that_finds_new_content_counts_as_a_change() {
    // Size and mtime can lie: same size, restored mtime, different bytes.
    let harness = support::Harness::git_repo();
    let path = harness.path("src/sneaky.rs");
    harness.write("src/sneaky.rs", "aaaa\n");
    let options = SyncOptions {
        recheck_budget: 8,
        recheck_age_generations: 0,
        ..SyncOptions::default()
    };
    harness.sync_with(&options).expect("first run");
    let original = std::fs::metadata(&path)
        .expect("metadata")
        .modified()
        .expect("mtime");
    let same_size = "bbbb\n";
    harness.write("src/sneaky.rs", same_size);
    let handle = std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open");
    handle
        .set_times(std::fs::FileTimes::new().set_modified(original))
        .expect("restore mtime");
    let out = harness.sync_with(&options).expect("second run");
    assert!(out.hashed >= 1, "the rotation rehashed the file");
    assert_eq!(
        harness.state().pending["src/sneaky.rs"].digest.as_deref(),
        Some(digest_of(same_size).as_str())
    );
}
