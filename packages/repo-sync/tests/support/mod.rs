//! Shared harness for the flat tests.
//!
//! Every test gets its own state directory and its own Git work tree under the
//! process temp dir, removed when the harness drops. The harness drives the
//! production entry point (`retaindb_repo::cli::run`), not internal helpers, so
//! a test only passes when the command a user runs behaves correctly.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use retaindb_repo::git::ProcessGit;
use retaindb_repo::queue::HintRecord;
use retaindb_repo::store::Store;
use retaindb_repo::sync::{SyncError, SyncOptions, SyncOutcome};
use retaindb_repo::sync_state::SyncState;

/// Parsed `key=value` output of a subcommand.
pub type KeyValues = BTreeMap<String, String>;

static NEXT_ID: AtomicU32 = AtomicU32::new(0);

/// A disposable state dir plus a work tree to point at.
pub struct Harness {
    base: PathBuf,
    /// Absolute path of the checked-out work tree.
    pub root: PathBuf,
    /// State directory backing the CLI.
    pub store: Store,
}

/// Result of one CLI invocation.
pub struct Run {
    pub code: i32,
    pub stdout: String,
}

impl Harness {
    /// Fresh work tree and empty state dir; the root is not enrolled.
    pub fn new() -> Self {
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("retaindb-repo-{}-{id}", std::process::id()));
        let root = base.join("repo");
        let state = base.join("state");
        fs::create_dir_all(&root).expect("work tree");
        fs::create_dir_all(&state).expect("state dir");
        Self {
            base,
            root,
            store: Store::open(&state),
        }
    }

    /// Harness with the work tree already enrolled.
    pub fn enrolled() -> Self {
        let harness = Self::new();
        let run = harness.run(&["enroll", "--root", &harness.root_text()], "");
        assert_eq!(run.code, 0, "enroll failed: {}", run.stdout);
        harness
    }

    /// A Git work tree with one committed file.
    pub fn git_repo() -> Self {
        let harness = Self::enrolled();
        harness.git(&["init", "-q"]);
        harness.git(&["config", "user.email", "test@example.com"]);
        harness.git(&["config", "user.name", "test"]);
        harness.write("README.md", "hello\n");
        harness.git(&["add", "-A"]);
        harness.git(&["commit", "-qm", "init"]);
        harness
    }

    /// Run `git` inside the work tree and return stdout.
    pub fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// Path of the work tree as text, for `--root`.
    pub fn root_text(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    /// Invoke the CLI with `args` and `stdin`.
    pub fn run(&self, args: &[&str], stdin: &str) -> Run {
        run_in(&self.store, args, stdin)
    }

    /// Write a file inside the work tree, creating parent directories.
    pub fn write(&self, relative: &str, contents: &str) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir");
        }
        fs::write(path, contents).expect("write file");
    }

    /// Absolute path of a file inside the work tree.
    pub fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    /// Hints currently queued in the state dir.
    pub fn queue(&self) -> Vec<HintRecord> {
        self.store.queue().expect("queue readable").hints().to_vec()
    }

    /// Number of queued hints.
    pub fn queue_depth(&self) -> usize {
        self.queue().len()
    }

    /// Raw state file contents, for corruption tests.
    pub fn state_file(&self, name: &str) -> PathBuf {
        self.store.dir().join(name)
    }

    /// Run `sync` through the CLI and return its `key=value` output.
    pub fn sync(&self) -> KeyValues {
        let run = self.run(&["sync", "--root", &self.root_text()], "");
        assert_eq!(run.code, 0, "sync failed: {}", run.stdout);
        parse_kv(&run.stdout)
    }

    /// Run `sync` through the CLI, expecting a failure; returns the exit code.
    pub fn sync_failure(&self) -> i32 {
        self.run(&["sync", "--root", &self.root_text()], "").code
    }

    /// Run the reconcile engine directly, with explicit limits.
    pub fn sync_with(&self, options: &SyncOptions) -> Result<SyncOutcome, SyncError> {
        retaindb_repo::sync::run(&self.root, &self.store, &ProcessGit, options)
    }

    /// Stored reconcile state.
    pub fn state(&self) -> SyncState {
        self.store.sync_state().expect("state readable")
    }

    /// Run `status` and return its `key=value` output.
    pub fn status(&self) -> KeyValues {
        let run = self.run(&["status", "--root", &self.root_text()], "");
        assert_eq!(run.code, 0, "status failed: {}", run.stdout);
        parse_kv(&run.stdout)
    }

    /// Write raw bytes inside the work tree.
    pub fn write_bytes(&self, relative: &str, bytes: &[u8]) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir");
        }
        fs::write(path, bytes).expect("write bytes");
    }

    /// Create a directory inside the work tree.
    pub fn mkdir(&self, relative: &str) {
        fs::create_dir_all(self.root.join(relative)).expect("mkdir");
    }

    /// Stage everything and commit it.
    pub fn commit_all(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-qm", message]);
    }

    /// Commit an index entry whose name is raw bytes, with no work-tree file.
    ///
    /// macOS refuses to create a non-UTF-8 filename on disk, but Git carries
    /// one without complaint, so this is how a test plants a name the client
    /// cannot decode.
    pub fn commit_raw_index_entry(&self, blob: &str, raw_name: &[u8], message: &str) {
        let mut cacheinfo = format!("100644,{blob},").into_bytes();
        cacheinfo.extend_from_slice(raw_name);
        let output = Command::new("git")
            .arg("update-index")
            .arg("--add")
            .arg("--cacheinfo")
            .arg(std::ffi::OsStr::from_bytes(&cacheinfo))
            .current_dir(&self.root)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "update-index failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        self.git(&["commit", "-qm", message]);
    }

    /// All pending changes, as `path -> kind` pairs.
    pub fn pending(&self) -> std::collections::BTreeMap<String, String> {
        self.state()
            .pending
            .iter()
            .map(|(path, change)| (path.clone(), change.kind.as_str().to_string()))
            .collect()
    }
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

/// Read a file's raw bytes (test-side helper, never used by the client).
pub fn read_bytes(path: &Path) -> Vec<u8> {
    fs::read(path).expect("readable")
}

/// Parse `key=value` lines into a map.
pub fn parse_kv(text: &str) -> KeyValues {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_string(), value.trim().to_string()))
        .collect()
}

/// Invoke the CLI against an explicit state dir.
pub fn run_in(store: &Store, args: &[&str], stdin: &str) -> Run {
    let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    let mut input = stdin.as_bytes();
    let mut output = Vec::new();
    let code = retaindb_repo::cli::run(&owned, &mut input, &mut output, store);
    Run {
        code,
        stdout: String::from_utf8_lossy(&output).into_owned(),
    }
}

/// Claude Code `PostToolUse` payload for a `Read` call.
///
/// Shape source: Claude Code hooks reference, `PostToolUse` input for the
/// `Read` tool (`tool_input.file_path`, `cwd`, `tool_use_id`).
pub fn claude_read_event(cwd: &Path, file_path: &str, tool_use_id: &str) -> String {
    format!(
        r#"{{"schema_version":1,"session_id":"sess_1","hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{{"file_path":"{file_path}"}},"tool_use_id":"{tool_use_id}","cwd":"{}"}}"#,
        cwd.display()
    )
}

/// Hermes `post_tool_call` payload for `read_file`.
///
/// Shape source: Hermes tool-call hook (`tool_input.path`, `extra.status`,
/// encoded `extra.result`).
pub fn hermes_read_event(cwd: &Path, path: &str) -> String {
    format!(
        r#"{{"schema_version":1,"tool_name":"read_file","tool_input":{{"path":"{path}"}},"cwd":"{}","extra":{{"status":"success","result":{{"body":"BASE64-ENCODED-BODY"}}}}}}"#,
        cwd.display()
    )
}

/// Hermes payload for a failed read.
pub fn hermes_failed_read_event(cwd: &Path, path: &str) -> String {
    format!(
        r#"{{"schema_version":1,"tool_name":"read_file","tool_input":{{"path":"{path}"}},"cwd":"{}","extra":{{"status":"error","result":null}}}}"#,
        cwd.display()
    )
}

/// Codex lifecycle payload (`SessionStart` / `Stop`).
///
/// Shape source: Codex lifecycle hooks; there is no per-file read event, so the
/// adapter only accepts these two names.
pub fn codex_lifecycle_event(name: &str) -> String {
    format!(r#"{{"schema_version":1,"hook_event_name":"{name}","session_id":"sess_1"}}"#)
}

/// A hook hint as one queue record, for readable assertions.
pub fn hint_for(
    hints: &[retaindb_repo::queue::HintRecord],
    path: &str,
) -> retaindb_repo::queue::HintRecord {
    hints
        .iter()
        .find(|hint| hint.path.as_deref() == Some(path))
        .unwrap_or_else(|| panic!("no queued hint for {path}; have {hints:?}"))
        .clone()
}
