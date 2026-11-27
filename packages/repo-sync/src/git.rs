//! Git access for the reconcile path.
//!
//! Two read-only subprocesses, both NUL-separated so filenames with spaces or
//! newlines cannot desynchronise the parse:
//! - `git ls-tree -r -z --full-tree HEAD` lists the tracked entries;
//! - `git status --porcelain -z` lists working-tree changes and, by default,
//!   already honours `.gitignore` for untracked files.
//!
//! `GIT_OPTIONAL_LOCKS=0` keeps `git status` from refreshing the index, so the
//! client never writes to the repository it is reading.
//!
//! A single record this build cannot decode — a filename whose bytes are not
//! UTF-8 — becomes an `Unnameable` entry and is counted as skipped. It never
//! fails the listing, because one such name must not disable sync forever.

use std::path::Path;
use std::process::Command;

/// Git object kind of an index entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeKind {
    /// Regular file (`100644` / `100755`).
    Blob,
    /// Symbolic link entry (`120000`).
    Symlink,
    /// Gitlink / submodule (`160000`).
    Submodule,
    /// Anything else (tree, unknown mode).
    Other,
    /// The record's filename is not valid UTF-8: it cannot be named in this
    /// build, so the inventory counts it as skipped and moves on.
    Unnameable,
}

/// One `ls-tree` record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    pub mode: String,
    pub kind: TreeKind,
    pub path: String,
}

/// Working-tree change reported by `git status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Other,
    /// The record's filename is not valid UTF-8: counted as skipped, never
    /// indexed.
    Unnameable,
}

/// One `git status --porcelain -z` record. A rename carries both paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusEntry {
    pub new_path: String,
    pub old_path: Option<String>,
    pub kind: StatusKind,
}

/// Git failures. Any failure aborts a sync without touching stored state.
#[derive(Debug)]
pub enum GitError {
    /// `git` could not be started.
    Spawn(std::io::Error),
    /// `git` exited non-zero.
    Exit { status: i32, stderr: String },
    /// Output did not match the `-z` format this parser expects.
    Format(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(error) => write!(f, "cannot run git: {error}"),
            Self::Exit { status, stderr } => write!(f, "git exited {status}: {stderr}"),
            Self::Format(reason) => write!(f, "unexpected git output: {reason}"),
        }
    }
}

impl std::error::Error for GitError {}

/// The two read-only queries the reconcile needs, injectable so tests can
/// simulate an interrupted inventory.
pub trait Git {
    /// Tracked entries at HEAD.
    fn ls_tree(&self, root: &Path) -> Result<Vec<TreeEntry>, GitError>;
    /// Working-tree changes.
    fn status(&self, root: &Path) -> Result<Vec<StatusEntry>, GitError>;
}

/// Real implementation: spawns `git` and parses `-z` output.
pub struct ProcessGit;

impl Git for ProcessGit {
    fn ls_tree(&self, root: &Path) -> Result<Vec<TreeEntry>, GitError> {
        let args = ["ls-tree", "-r", "-z", "--full-tree", "HEAD"];
        match run_git(root, &args) {
            Ok(output) => parse_ls_tree(&output),
            // An unborn branch has no HEAD yet; that is an empty tree, not a
            // failure, and it can only be empty (nothing is tracked).
            Err(GitError::Exit { stderr, .. }) if unborn_head(&stderr) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    fn status(&self, root: &Path) -> Result<Vec<StatusEntry>, GitError> {
        // `--untracked-files=all` matters: without it Git collapses a whole
        // untracked directory into one `?? dir/` record and per-file paths never
        // reach the inventory.
        parse_status(&run_git(
            root,
            &["status", "--porcelain", "-z", "--untracked-files=all"],
        )?)
    }
}

fn unborn_head(stderr: &str) -> bool {
    stderr.contains("Not a valid object name") || stderr.contains("bad object")
}

fn run_git(root: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(GitError::Spawn)?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(GitError::Exit {
        status: output.status.code().unwrap_or(-1),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

/// Parse `git ls-tree -r -z --full-tree HEAD` (`<mode> <type> <sha>\t<path>\0`).
pub fn parse_ls_tree(output: &[u8]) -> Result<Vec<TreeEntry>, GitError> {
    let mut entries = Vec::new();
    for record in output.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        entries.push(parse_tree_record(record)?);
    }
    Ok(entries)
}

fn parse_tree_record(record: &[u8]) -> Result<TreeEntry, GitError> {
    let tab = record
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| GitError::Format("ls-tree record without a tab".to_string()))?;
    let head = std::str::from_utf8(&record[..tab])
        .map_err(|_| GitError::Format("non-utf-8 ls-tree header".to_string()))?;
    let mut parts = head.split(' ');
    let mode = parts
        .next()
        .filter(|mode| !mode.is_empty())
        .ok_or_else(|| GitError::Format("ls-tree record without a mode".to_string()))?;
    let object = parts
        .next()
        .ok_or_else(|| GitError::Format("ls-tree record without a type".to_string()))?;
    let Ok(path) = std::str::from_utf8(&record[tab + 1..]) else {
        // A name this build cannot decode costs one record, not the
        // repository: the inventory counts it and the rest still syncs.
        return Ok(TreeEntry {
            mode: mode.to_string(),
            kind: TreeKind::Unnameable,
            path: String::new(),
        });
    };
    Ok(TreeEntry {
        mode: mode.to_string(),
        kind: tree_kind(mode, object),
        path: path.to_string(),
    })
}

fn tree_kind(mode: &str, object: &str) -> TreeKind {
    match (mode, object) {
        ("160000", _) => TreeKind::Submodule,
        ("120000", _) => TreeKind::Symlink,
        (_, "blob") => TreeKind::Blob,
        _ => TreeKind::Other,
    }
}

/// Parse `git status --porcelain -z` (`XY <path>\0[<old path>\0]`).
pub fn parse_status(output: &[u8]) -> Result<Vec<StatusEntry>, GitError> {
    let fields: Vec<&[u8]> = output
        .split(|byte| *byte == 0)
        .filter(|f| !f.is_empty())
        .collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let field = fields[index];
        if field.len() < 4 || field[2] != b' ' {
            return Err(GitError::Format("malformed status record".to_string()));
        }
        let code = &field[..2];
        let kind = status_kind(code);
        // A rename or copy carries its source as the next field, whoever
        // detected it. Consume it even when a name cannot be decoded, or every
        // later record shifts by one.
        let source = if moved(code) {
            index += 1;
            Some(
                fields
                    .get(index)
                    .copied()
                    .ok_or_else(|| GitError::Format("rename without a source path".to_string()))?,
            )
        } else {
            None
        };
        entries.push(status_entry(kind, field, source));
        index += 1;
    }
    Ok(entries)
}

/// One status record; an undecodable name becomes an `Unnameable` entry.
fn status_entry(kind: StatusKind, field: &[u8], source: Option<&[u8]>) -> StatusEntry {
    match name(field, 3) {
        Some(new_path) => StatusEntry {
            new_path,
            old_path: source.and_then(|old| name(old, 0)),
            kind,
        },
        None => StatusEntry {
            new_path: String::new(),
            old_path: None,
            kind: StatusKind::Unnameable,
        },
    }
}

/// Does this status code carry a second, source-path field?
fn moved(code: &[u8]) -> bool {
    matches!(code, [b'R' | b'C', _] | [_, b'R' | b'C'])
}

fn name(field: &[u8], skip: usize) -> Option<String> {
    std::str::from_utf8(&field[skip..]).ok().map(str::to_string)
}

fn status_kind(code: &[u8]) -> StatusKind {
    match code {
        b"??" => StatusKind::Untracked,
        [b'R', _] | [_, b'R'] => StatusKind::Renamed,
        [b'D', _] | [_, b'D'] => StatusKind::Deleted,
        [b'A', _] | [b'C', _] => StatusKind::Added,
        [b'M', _] | [_, b'M'] | [b'T', _] | [_, b'T'] => StatusKind::Modified,
        _ => StatusKind::Other,
    }
}
