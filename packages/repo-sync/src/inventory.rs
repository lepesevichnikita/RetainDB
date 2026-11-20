//! Inventory: the candidate set for one reconcile pass.
//!
//! Sources, in this order:
//! 1. tracked blobs from `git ls-tree` (symlinks and gitlinks are refused here);
//! 2. working-tree changes from `git status` (untracked files are already
//!    filtered by `.gitignore`).
//!
//! A path only becomes a tombstone when Git accounts for it — a working-tree
//! deletion or rename away, or a path the pinned HEAD tree no longer names
//! after a commit — *and* the filesystem confirms it is absent. Nothing else
//! may delete index state: not an unreadable file, not a failed listing, not a
//! policy skip.

use std::collections::BTreeSet;
use std::path::Path;

use crate::git::{Git, StatusKind, TreeKind};
use crate::hint::RelPath;
use crate::policy;
use crate::sync::{SyncError, SyncOptions};

/// Candidate set for one run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Candidates {
    /// Paths to digest, sorted.
    pub files: Vec<String>,
    /// Paths confirmed gone, sorted.
    pub tombstones: Vec<String>,
    /// Every path the pinned HEAD tree names, whatever its kind. A committed
    /// deletion leaves no working-tree trace, so the tree is the only evidence.
    pub head: BTreeSet<String>,
    /// Paths refused before or during inspection.
    pub skipped: usize,
}

/// Collect candidates. Any Git failure aborts the whole pass.
pub fn collect(root: &Path, git: &dyn Git, options: &SyncOptions) -> Result<Candidates, SyncError> {
    let tree = git.ls_tree(root).map_err(SyncError::Git)?;
    let status = git.status(root).map_err(SyncError::Git)?;
    let mut seen = Seen::default();
    seen.absorb_tree(tree);
    seen.absorb_status(status);
    let files = seen.accepted_files(root, options);
    let skipped = seen.skipped + seen.files.len() - files.len();
    let tombstones = seen.confirmed_tombstones(root, &files);
    Ok(Candidates {
        files,
        tombstones,
        head: seen.head,
        skipped,
    })
}

/// Intermediate sets, kept together because they are read as one picture.
#[derive(Default)]
struct Seen {
    files: BTreeSet<String>,
    deletions: BTreeSet<String>,
    gitlinks: BTreeSet<String>,
    head: BTreeSet<String>,
    skipped: usize,
}

impl Seen {
    fn absorb_tree(&mut self, tree: Vec<crate::git::TreeEntry>) {
        for entry in tree {
            match entry.kind {
                TreeKind::Blob => {
                    self.head.insert(entry.path.clone());
                    self.files.insert(entry.path);
                }
                TreeKind::Symlink => {
                    self.head.insert(entry.path);
                    self.skipped += 1;
                }
                TreeKind::Submodule => {
                    self.head.insert(entry.path.clone());
                    self.gitlinks.insert(entry.path);
                    self.skipped += 1;
                }
                // Unknown mode, or a filename this build cannot name: the
                // record is counted and dropped, never indexed.
                TreeKind::Other | TreeKind::Unnameable => self.skipped += 1,
            }
        }
    }

    fn absorb_status(&mut self, status: Vec<crate::git::StatusEntry>) {
        for entry in status {
            match entry.kind {
                StatusKind::Deleted => {
                    self.deletions.insert(entry.new_path);
                }
                StatusKind::Renamed => {
                    if let Some(old) = entry.old_path {
                        self.deletions.insert(old);
                    }
                    self.files.insert(entry.new_path);
                }
                StatusKind::Added
                | StatusKind::Modified
                | StatusKind::Untracked
                | StatusKind::Other => {
                    self.files.insert(entry.new_path);
                }
                // A record whose filename is not UTF-8 cannot be stored; Git
                // still reports it, so count it and leave the rest alone.
                StatusKind::Unnameable => self.skipped += 1,
            }
        }
    }

    /// Files that pass name policy and on-disk checks.
    fn accepted_files(&self, root: &Path, options: &SyncOptions) -> Vec<String> {
        self.files
            .iter()
            .filter(|path| file_allowed(root, path, options))
            .cloned()
            .collect()
    }

    /// Deletions that Git named explicitly and the filesystem confirms.
    fn confirmed_tombstones(&self, root: &Path, files: &[String]) -> Vec<String> {
        self.deletions
            .iter()
            .filter(|path| !files.contains(path))
            .filter(|path| !self.gitlinks.contains(*path))
            .filter(|path| !policy::is_excluded(path))
            .filter(|path| RelPath::parse(path).is_ok())
            .filter(|path| policy::confirmed_absent(root, path))
            .cloned()
            .collect()
    }
}

fn file_allowed(root: &Path, path: &str, options: &SyncOptions) -> bool {
    if policy::is_excluded(path) {
        return false;
    }
    if RelPath::parse(path).is_err() {
        return false;
    }
    policy::check_path(root, path, options.max_file_bytes).is_ok()
}
