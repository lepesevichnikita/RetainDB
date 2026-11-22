//! Deletions, renames and interruptions. The rule: a tombstone needs explicit
//! Git evidence plus a confirmed absence; a failed inventory produces nothing.

mod support;

use std::path::Path;

use retaindb_repo::git::{Git, GitError, StatusEntry, StatusKind, TreeEntry};
use retaindb_repo::sync::{self, SyncOptions};
use retaindb_repo::sync_state::ChangeKind;

/// Git stub: no tracked entries, and the status query is "interrupted".
struct InterruptedStatus;

impl Git for InterruptedStatus {
    fn ls_tree(&self, _root: &Path) -> Result<Vec<TreeEntry>, GitError> {
        Ok(Vec::new())
    }

    fn status(&self, _root: &Path) -> Result<Vec<StatusEntry>, GitError> {
        Err(GitError::Format("simulated interruption".to_string()))
    }
}

#[test]
fn committed_deletion_becomes_a_tombstone() {
    // After `git commit` the deleted path is in neither the HEAD tree nor
    // `git status`, so a working-tree signal can never see it. The confirmed
    // set minus the pinned HEAD tree is what retires it.
    let harness = support::Harness::git_repo();
    harness.write("src/gone.txt", "gone\n");
    harness.commit_all("add gone");
    let first = harness.sync();
    let generation = first["generation"].parse::<u64>().expect("generation");
    assert!(harness.state().files.contains_key("src/gone.txt"));
    std::fs::remove_file(harness.path("src/gone.txt")).expect("remove");
    harness.commit_all("delete gone");
    assert!(
        harness.git(&["status", "--porcelain", "-z"]).is_empty(),
        "the deletion is committed, so status is clean"
    );
    let out = harness.sync();
    assert_eq!(out["tombstones"], "1", "one path died");
    assert_eq!(
        out["generation"],
        (generation + 1).to_string(),
        "a tombstone is a change, so the generation advances"
    );
    let state = harness.state();
    assert!(
        !state.files.contains_key("src/gone.txt"),
        "a tombstoned path leaves the digest cache"
    );
    assert_eq!(
        state.pending["src/gone.txt"].kind,
        ChangeKind::Tombstone,
        "the pending change tells the server to drop it"
    );
    assert_eq!(state.pending["src/gone.txt"].digest, None);
}

#[test]
fn committed_rename_produces_one_upsert_and_one_tombstone() {
    // `git mv` + commit: the new name is in HEAD, the old name is nowhere.
    let harness = support::Harness::git_repo();
    harness.write("src/old.txt", "same content\n");
    harness.commit_all("add old");
    harness.sync();
    harness.git(&["mv", "src/old.txt", "src/new.txt"]);
    harness.git(&["commit", "-qm", "rename"]);
    let out = harness.sync();
    assert_eq!(out["upserts"], "1");
    assert_eq!(out["tombstones"], "1");
    let state = harness.state();
    assert_eq!(state.pending["src/new.txt"].kind, ChangeKind::Upsert);
    assert_eq!(state.pending["src/old.txt"].kind, ChangeKind::Tombstone);
    assert!(!state.files.contains_key("src/old.txt"));
}

#[test]
fn committed_removal_is_not_a_tombstone_while_the_file_is_still_there() {
    // `git rm --cached` takes the path out of HEAD but leaves it on disk. The
    // absence confirmation must refuse to retire a file that still exists.
    let harness = support::Harness::git_repo();
    harness.write("kept.txt", "still here\n");
    harness.commit_all("add kept");
    harness.write(".gitignore", "kept.txt\n");
    harness.commit_all("ignore kept");
    harness.sync();
    assert!(harness.state().files.contains_key("kept.txt"));
    harness.git(&["rm", "-q", "--cached", "kept.txt"]);
    harness.git(&["commit", "-qm", "drop from index"]);
    harness.sync();
    let state = harness.state();
    assert!(
        state.files.contains_key("kept.txt"),
        "an existing file keeps its cached digest"
    );
    assert!(state.pending.get("kept.txt").map(|change| change.kind) != Some(ChangeKind::Tombstone));
}

/// Git stub: the tree query is "interrupted", the status query is empty.
struct InterruptedTree;

impl Git for InterruptedTree {
    fn ls_tree(&self, _root: &Path) -> Result<Vec<TreeEntry>, GitError> {
        Err(GitError::Exit {
            status: 128,
            stderr: "simulated interruption".to_string(),
        })
    }

    fn status(&self, _root: &Path) -> Result<Vec<StatusEntry>, GitError> {
        Ok(Vec::new())
    }
}

#[test]
fn rename_produces_one_upsert_and_one_tombstone() {
    // A rename is a new path plus a dead path, in the same generation.
    let harness = support::Harness::git_repo();
    harness.write("src/a.txt", "alpha\n");
    harness.commit_all("a");
    harness.sync();
    harness.git(&["mv", "src/a.txt", "src/b.txt"]);
    let out = harness.sync();
    assert_eq!(out["upserts"], "1");
    assert_eq!(out["tombstones"], "1");
    let state = harness.state();
    assert_eq!(state.pending["src/b.txt"].kind, ChangeKind::Upsert);
    assert_eq!(state.pending["src/a.txt"].kind, ChangeKind::Tombstone);
    assert_eq!(
        state.pending["src/a.txt"].generation, state.pending["src/b.txt"].generation,
        "both halves belong to one generation"
    );
}

#[test]
fn a_worktree_rename_record_consumes_its_source_path() {
    // A rename can be reported in either status column, and both forms carry
    // the source as a second `-z` field. Misreading it shifts every later
    // record, so this checks the raw stream, not the candidate set.
    let entries = retaindb_repo::git::parse_status(b" R new.txt\0old.txt\0 M a.txt\0")
        .expect("the stream parses");
    assert_eq!(entries.len(), 2, "two records, not three");
    assert_eq!(entries[0].kind, StatusKind::Renamed);
    assert_eq!(entries[0].new_path, "new.txt");
    assert_eq!(entries[0].old_path.as_deref(), Some("old.txt"));
    assert_eq!(entries[1].new_path, "a.txt");
}

#[test]
fn deleted_file_produces_a_tombstone() {
    // `git rm` is explicit evidence: the path is gone and stays gone.
    let harness = support::Harness::git_repo();
    harness.git(&["rm", "-q", "README.md"]);
    let out = harness.sync();
    assert_eq!(out["tombstones"], "1");
    assert_eq!(
        harness.state().pending["README.md"].kind,
        ChangeKind::Tombstone
    );
}

#[test]
fn file_deleted_and_recreated_before_sync_is_an_upsert_only() {
    // Coalescing wins: the path exists, so it cannot also be a tombstone.
    let harness = support::Harness::git_repo();
    harness.write("src/keep.txt", "first\n");
    harness.commit_all("keep");
    harness.sync();
    std::fs::remove_file(harness.path("src/keep.txt")).expect("remove");
    harness.write("src/keep.txt", "second\n");
    harness.sync();
    let state = harness.state();
    assert_eq!(state.pending["src/keep.txt"].kind, ChangeKind::Upsert);
    assert!(state.pending.contains_key("src/keep.txt"));
}

#[test]
fn interrupted_inventory_produces_no_tombstones() {
    // An empty tree listing plus a failed status must abort, not delete.
    let harness = support::Harness::git_repo();
    harness.sync();
    let before = harness.state();
    let result = sync::run(
        &harness.root,
        &harness.store,
        &InterruptedStatus,
        &SyncOptions::default(),
    );
    assert!(result.is_err(), "interrupted inventory must fail the run");
    let after = harness.state();
    assert_eq!(after.generation, before.generation, "no new generation");
    assert_eq!(after.pending, before.pending, "no tombstones appeared");
}

#[test]
fn unreadable_file_is_skipped_and_never_tombstoned() {
    // A permission error is not a deletion signal.
    let harness = support::Harness::git_repo();
    harness.write("src/locked.txt", "locked\n");
    harness.commit_all("locked");
    harness.sync();
    let path = harness.path("src/locked.txt");
    let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o000);
    std::fs::set_permissions(&path, permissions).expect("chmod");
    let unreadable = std::fs::read(&path).is_err();
    harness.sync();
    let state = harness.state();
    if unreadable {
        assert_eq!(
            state.pending["src/locked.txt"].kind,
            ChangeKind::Upsert,
            "keeps the previous upsert instead of inventing a deletion"
        );
    }
    assert!(
        state
            .pending
            .get("src/locked.txt")
            .map(|change| change.kind)
            != Some(ChangeKind::Tombstone)
    );
    let mut restore = std::fs::metadata(&path).expect("metadata").permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut restore, 0o644);
    std::fs::set_permissions(&path, restore).expect("restore mode");
}

#[test]
fn interrupted_tree_listing_produces_no_tombstones() {
    // The HEAD tree is a tombstone source now: if reading it fails, the run
    // must abort with the confirmed set intact, never with an empty tree.
    let harness = support::Harness::git_repo();
    harness.write("src/keep.txt", "keep\n");
    harness.commit_all("keep");
    harness.sync();
    let before = harness.state();
    let result = sync::run(
        &harness.root,
        &harness.store,
        &InterruptedTree,
        &SyncOptions::default(),
    );
    assert!(
        result.is_err(),
        "interrupted tree listing must fail the run"
    );
    let after = harness.state();
    assert_eq!(after.generation, before.generation, "no new generation");
    assert_eq!(after.files, before.files, "the confirmed set is untouched");
    assert_eq!(after.pending, before.pending, "no tombstones appeared");
}

#[test]
fn sync_refuses_a_root_that_is_not_the_enrolled_one() {
    // Reconcile state belongs to one root; a mismatch would corrupt it.
    let harness = support::Harness::git_repo();
    let other = support::Harness::git_repo();
    let result = sync::run(
        &other.root,
        &harness.store,
        &retaindb_repo::git::ProcessGit,
        &SyncOptions::default(),
    );
    assert!(result.is_err(), "foreign root must be refused");
}
