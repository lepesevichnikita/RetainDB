//! State-directory permissions: hints name repository paths, so the queue and
//! the reconcile state are readable by their owner only.

mod support;

#[cfg(unix)]
fn mode_of(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

#[cfg(unix)]
#[test]
fn state_files_are_owner_only() {
    // Another local user must not be able to read queued paths.
    let harness = support::Harness::enrolled();
    harness.run(
        &["hook", "--client", "claude"],
        &support::claude_read_event(&harness.root, "src/main.rs", "toolu_mode"),
    );
    assert_eq!(mode_of(&harness.state_file("enrollment.json")), 0o600);
    assert_eq!(mode_of(&harness.state_file("queue.json")), 0o600);
}

#[cfg(unix)]
#[test]
fn state_directory_is_owner_only() {
    // The directory itself must not be traversable by other users either.
    let harness = support::Harness::enrolled();
    harness.run(
        &["hook", "--client", "claude"],
        &support::claude_read_event(&harness.root, "src/main.rs", "toolu_dir"),
    );
    assert_eq!(mode_of(harness.store.dir()), 0o700);
}

#[cfg(unix)]
#[test]
fn sync_state_file_is_owner_only() {
    // The digest cache also names every indexed file.
    let harness = support::Harness::git_repo();
    harness.sync();
    assert_eq!(mode_of(&harness.state_file("sync.json")), 0o600);
}
