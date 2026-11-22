//! Inventory: which working-tree files become digest-only upserts, and which
//! are refused before any content leaves the machine.

mod support;

#[test]
fn sync_upserts_tracked_text_files_with_digests() {
    // The core pass: tracked text files become one pending upsert each.
    let harness = support::Harness::git_repo();
    harness.write("src/main.rs", "fn main() {}\n");
    harness.commit_all("add main");
    let out = harness.sync();
    assert_eq!(out["upserts"], "2");
    assert_eq!(out["tombstones"], "0");
    let pending = harness.pending();
    assert_eq!(pending.get("README.md").map(String::as_str), Some("upsert"));
    assert_eq!(
        pending.get("src/main.rs").map(String::as_str),
        Some("upsert")
    );
    // Digest is real content SHA-256, not a placeholder.
    assert_eq!(
        harness.state().pending["README.md"].digest.as_deref(),
        Some("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03")
    );
}

#[test]
fn sync_includes_untracked_files_but_honours_gitignore() {
    // A brand-new file counts; an ignored one never enters the inventory.
    let harness = support::Harness::git_repo();
    harness.write(".gitignore", "ignored.txt\n");
    harness.write("untracked.rs", "fn fresh() {}\n");
    harness.write("ignored.txt", "nope\n");
    harness.sync();
    let state = harness.state();
    assert!(state.pending.contains_key("untracked.rs"));
    assert!(
        !state.pending.contains_key("ignored.txt"),
        "gitignore is honoured"
    );
    assert!(
        !state.files.contains_key("ignored.txt"),
        "an ignored file is never digested"
    );
}

#[test]
fn sync_skips_vendor_and_generated_directories() {
    // node_modules/target/dist content is generated; indexing it is noise.
    let harness = support::Harness::git_repo();
    harness.write("node_modules/pkg/index.js", "module.exports = 1;\n");
    harness.write("target/debug/app", "binary-ish\n");
    harness.write("dist/bundle.min.js", "var a=1;\n");
    harness.write("src/app.rs", "fn app() {}\n");
    let out = harness.sync();
    let pending = harness.pending();
    assert!(pending.contains_key("src/app.rs"));
    assert!(!pending.contains_key("node_modules/pkg/index.js"));
    assert!(!pending.contains_key("target/debug/app"));
    assert!(!pending.contains_key("dist/bundle.min.js"));
    assert!(out["skipped"].parse::<usize>().expect("number") >= 3);
}

#[test]
fn sync_skips_symlinks_to_outside_files() {
    // A symlink is a door out of the repository; never follow it.
    let harness = support::Harness::git_repo();
    let outside = harness.root.parent().expect("base").join("outside.txt");
    std::fs::write(&outside, "outside secret\n").expect("write outside");
    std::os::unix::fs::symlink(&outside, harness.path("link.txt")).expect("symlink");
    harness.commit_all("symlink");
    let out = harness.sync();
    assert!(!harness.pending().contains_key("link.txt"));
    assert!(out["skipped"].parse::<usize>().expect("number") >= 1);
}

#[test]
fn sync_skips_a_file_replaced_by_a_symlink() {
    // A tracked file swapped for a symlink must not be hashed through the link.
    let harness = support::Harness::git_repo();
    harness.write("data.txt", "original\n");
    harness.commit_all("data");
    harness.sync();
    let before = harness.state().files["data.txt"].digest.clone();
    std::fs::remove_file(harness.path("data.txt")).expect("remove");
    std::os::unix::fs::symlink("/etc/passwd", harness.path("data.txt")).expect("symlink");
    harness.sync();
    let state = harness.state();
    assert_eq!(
        state.files["data.txt"].digest, before,
        "cached digest is kept, not replaced by a read through the link"
    );
    assert!(
        !state.pending.contains_key("data.txt") || state.pending["data.txt"].digest == Some(before)
    );
}

#[test]
fn sync_skips_gitlink_entries() {
    // Submodules are separate repositories; the client must not walk into them.
    let harness = support::Harness::git_repo();
    harness.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        "160000,1111111111111111111111111111111111111111,vendor-lib",
    ]);
    harness.git(&["commit", "-qm", "gitlink"]);
    let out = harness.sync();
    assert!(!harness.pending().contains_key("vendor-lib"));
    assert!(out["skipped"].parse::<usize>().expect("number") >= 1);
}

#[test]
fn sync_skips_binary_files() {
    // A NUL byte in the first block marks non-text content.
    let harness = support::Harness::git_repo();
    harness.write_bytes(
        "assets/logo.bin",
        &[0x89, b'P', b'N', b'G', 0x00, 0x01, 0x02],
    );
    let out = harness.sync();
    assert!(!harness.pending().contains_key("assets/logo.bin"));
    assert!(out["skipped"].parse::<usize>().expect("number") >= 1);
}

#[test]
fn sync_skips_oversized_files() {
    // Above the limit the client refuses instead of streaming a huge file.
    let harness = support::Harness::git_repo();
    harness.write("big.txt", &"x".repeat(1024 * 1024 + 1));
    let out = harness.sync();
    assert!(!harness.pending().contains_key("big.txt"));
    assert!(out["skipped"].parse::<usize>().expect("number") >= 1);
}

#[test]
fn sync_skips_suspected_secret_files() {
    // Credentials do not belong in an index, even by name alone.
    let harness = support::Harness::git_repo();
    harness.write(".env", "TOKEN=abc\n");
    harness.write("certs/server.pem", "-----BEGIN CERTIFICATE-----\n");
    harness.write("id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    harness.sync();
    let pending = harness.pending();
    assert!(!pending.contains_key(".env"));
    assert!(!pending.contains_key("certs/server.pem"));
    assert!(!pending.contains_key("id_rsa"));
}

#[test]
fn sync_skips_a_secret_marker_past_the_first_sample() {
    // Secret scanning covers the whole file: a marker after the 8 KiB binary
    // probe used to be indexed, storing a SHA-256 of a private key.
    let harness = support::Harness::git_repo();
    let body = format!(
        "{}\n-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n",
        "x".repeat(9000)
    );
    harness.write("src/leak.txt", &body);
    let out = harness.sync();
    assert!(!harness.pending().contains_key("src/leak.txt"));
    assert!(
        !harness.state().files.contains_key("src/leak.txt"),
        "a refused file keeps no cached digest"
    );
    let digest = retaindb_repo::sha256::hex_digest(body.as_bytes());
    let state_text =
        String::from_utf8(support::read_bytes(&harness.state_file("sync.json"))).expect("utf-8");
    assert!(
        !state_text.contains(&digest),
        "no digest of a secret reaches the state file"
    );
    assert!(out["skipped"].parse::<usize>().expect("number") >= 1);
}

#[test]
fn sync_skips_file_content_that_looks_like_a_private_key() {
    // A key pasted into a normal-looking file is still a secret.
    let harness = support::Harness::git_repo();
    harness.write(
        "notes/config.txt",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n",
    );
    harness.sync();
    assert!(!harness.pending().contains_key("notes/config.txt"));
}

#[test]
fn sync_stores_no_file_bodies() {
    // Only digests and metadata are persisted, never content.
    let harness = support::Harness::git_repo();
    let marker = "UNIQUE-BODY-MARKER-9f3c2a";
    harness.write("src/body.rs", &format!("// {marker}\nfn body() {{}}\n"));
    harness.commit_all("body");
    harness.sync();
    let state_text = String::from_utf8(support::read_bytes(&harness.state_file("sync.json")))
        .expect("utf-8 state");
    let queue_text = std::fs::read(harness.state_file("queue.json"))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    assert!(!state_text.contains(marker), "state holds no body text");
    assert!(!queue_text.contains(marker), "queue holds no body text");
}

#[test]
fn unchanged_sync_does_not_advance_the_generation() {
    // A run with no changes produces no new batch.
    let harness = support::Harness::git_repo();
    let first = harness.sync();
    let generation = first["generation"].clone();
    let second = harness.sync();
    assert_eq!(second["generation"], generation);
    assert_eq!(second["upserts"], "0");
}

#[test]
fn offline_edits_coalesce_to_the_latest_content() {
    // Two edits between syncs are one pending change with the final digest.
    let harness = support::Harness::git_repo();
    harness.write("src/edit.rs", "fn first() {}\n");
    harness.sync();
    harness.write("src/edit.rs", "fn second() {}\n");
    harness.write("src/edit.rs", "fn third() {}\n");
    harness.sync();
    let state = harness.state();
    let digest = state.pending["src/edit.rs"].digest.clone().expect("digest");
    assert_eq!(
        digest,
        retaindb_repo::sha256::hex_digest(b"fn third() {}\n"),
        "the latest content wins"
    );
    assert_eq!(state.pending.len(), 2, "one entry per path, not per edit");
}

#[test]
fn sync_skips_a_record_whose_name_is_not_utf8() {
    // One undecodable filename must cost that record only, never the whole
    // repository: before, a single such path failed every sync forever.
    let harness = support::Harness::git_repo();
    harness.write("src/keep.rs", "fn keep() {}\n");
    harness.commit_all("keep");
    let blob = harness
        .git(&["rev-parse", "HEAD:src/keep.rs"])
        .trim()
        .to_string();
    harness.commit_raw_index_entry(&blob, b"bad\xff.txt", "raw name");
    let out = harness.sync();
    assert_eq!(out["upserts"], "2", "README.md and src/keep.rs still sync");
    assert!(
        out["skipped"].parse::<usize>().expect("number") >= 1,
        "the undecodable record is counted as skipped"
    );
    let state = harness.state();
    assert_eq!(state.files.len(), 2, "only nameable files are indexed");
    assert!(state.pending.contains_key("src/keep.rs"));
    assert!(state.pending.contains_key("README.md"));
}

#[test]
fn sync_outside_a_git_work_tree_fails() {
    // Without Git there is no trustworthy inventory to reconcile.
    let harness = support::Harness::enrolled();
    assert_eq!(harness.sync_failure(), 1);
    assert!(harness.state().pending.is_empty());
}
