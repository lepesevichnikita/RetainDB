//! The reconcile engine: Git-aware inventory in, digest-verified batch out.
//!
//! Safety rules encoded here:
//! - a failed or interrupted inventory aborts the run and changes nothing;
//! - a deletion is recorded only from explicit Git evidence — a working-tree
//!   deletion or rename away, or a path the pinned HEAD tree no longer names —
//!   plus a confirmed absence, never from "the path did not appear in this run";
//! - an unreadable, binary, oversized, symlinked or secret-looking file is
//!   skipped, keeping its previous state, and never becomes a tombstone;
//! - offline edits coalesce to the latest content per path;
//! - the receipt watermark only moves on an explicit confirmation.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::digest::{self, Content, Stat};
use crate::enrollment;
use crate::git::Git;
use crate::hint::RelPath;
use crate::inventory;
use crate::policy;
use crate::store::Store;
use crate::sync_state::{ChangeKind, FileState, PendingChange, SyncState};

/// Reconcile limits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncOptions {
    /// Files larger than this are skipped.
    pub max_file_bytes: u64,
    /// Unchanged files re-verified per run by the rotation.
    pub recheck_budget: usize,
    /// Only unchanged files older than this many generations are re-verified.
    pub recheck_age_generations: u64,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024,
            recheck_budget: 8,
            recheck_age_generations: 64,
        }
    }
}

/// What one sync run did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    pub generation: u64,
    pub upserts: usize,
    pub tombstones: usize,
    pub skipped: usize,
    pub hashed: usize,
    /// Paths that went through the hasher this run, in inventory order.
    pub hashed_paths: Vec<String>,
}

/// Sync failures; nothing is persisted when one of these is returned.
#[derive(Debug)]
pub enum SyncError {
    /// `root` is not the top of a Git working tree.
    NotAGitWorkTree,
    /// `root` is not the enrolled root for this state directory.
    ForeignRoot,
    /// An explicit receipt named a generation that does not exist.
    UnknownGeneration(u64),
    /// A Git query failed or was interrupted.
    Git(crate::git::GitError),
    /// Stored state could not be read or written.
    Store(crate::store::StoreError),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAGitWorkTree => f.write_str("root is not a git work tree"),
            Self::ForeignRoot => f.write_str("root is not the enrolled root"),
            Self::UnknownGeneration(generation) => {
                write!(f, "generation {generation} was never produced")
            }
            Self::Git(error) => write!(f, "{error}"),
            Self::Store(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SyncError {}

/// Run one reconcile pass.
pub fn run(
    root: &Path,
    store: &Store,
    git: &dyn Git,
    options: &SyncOptions,
) -> Result<SyncOutcome, SyncError> {
    let checked = checked_root(root, store)?;
    let candidates = inventory::collect(&checked, git, options)?;
    let mut state = store.sync_state().map_err(SyncError::Store)?;
    let rotation = Rotation::plan(&state, options);
    let committed = committed_tombstones(&checked, &candidates, &state);
    let mut pass = Pass::new(&state);
    pass.apply_files(&checked, &candidates.files, &rotation, options);
    pass.apply_tombstones(&candidates.tombstones);
    pass.apply_tombstones(&committed);
    let generation = pass.finish(&mut state, rotation.next_cursor);
    store.save_sync_state(&state).map_err(SyncError::Store)?;
    Ok(pass.outcome(generation, candidates.skipped))
}

/// Paths already confirmed that the pinned HEAD tree no longer names.
///
/// This is the committed-deletion source. After `git commit` a removed path
/// appears neither in the tree nor in `git status`, so no working-tree signal
/// can retire it. The guards are the same as for a working-tree deletion: a
/// valid relative path, and an `lstat` that says `NotFound` rather than
/// "unreadable". A path still on disk — now untracked or ignored — keeps its
/// state, and so does anything this run still lists as a file.
fn committed_tombstones(
    root: &Path,
    candidates: &inventory::Candidates,
    state: &SyncState,
) -> Vec<String> {
    let present: BTreeSet<&str> = candidates.files.iter().map(String::as_str).collect();
    let named: BTreeSet<&str> = candidates.tombstones.iter().map(String::as_str).collect();
    state
        .files
        .keys()
        .map(String::as_str)
        .filter(|path| !candidates.head.contains(*path))
        .filter(|path| !present.contains(*path))
        .filter(|path| !named.contains(*path))
        .filter(|path| !policy::is_excluded(path))
        .filter(|path| RelPath::parse(path).is_ok())
        .filter(|path| policy::confirmed_absent(root, path))
        .map(str::to_string)
        .collect()
}

/// Resolve the root and refuse a state directory that belongs elsewhere.
fn checked_root(root: &Path, store: &Store) -> Result<PathBuf, SyncError> {
    let enrollment = store.enrollment().map_err(SyncError::Store)?;
    let checked = enrollment::checked_root(root).map_err(SyncError::Store)?;
    if checked.canonical != enrollment.root {
        return Err(SyncError::ForeignRoot);
    }
    if !checked.canonical.join(".git").exists() {
        return Err(SyncError::NotAGitWorkTree);
    }
    Ok(checked.canonical)
}

/// One reconcile pass, staged so nothing is written until it finishes.
struct Pass {
    cache: BTreeMap<String, FileState>,
    pending_tombstones: BTreeSet<String>,
    updates: Vec<(String, PendingChange)>,
    hashed_paths: Vec<String>,
    skipped: usize,
    upserts: usize,
    tombstones: usize,
}

impl Pass {
    fn new(state: &SyncState) -> Self {
        let pending_tombstones = state
            .pending
            .iter()
            .filter(|(_, change)| change.kind == ChangeKind::Tombstone)
            .map(|(path, _)| path.clone())
            .collect();
        Self {
            cache: state.files.clone(),
            pending_tombstones,
            updates: Vec::new(),
            hashed_paths: Vec::new(),
            skipped: 0,
            upserts: 0,
            tombstones: 0,
        }
    }

    /// Digest each candidate: reuse the cache when stat and age allow it.
    fn apply_files(
        &mut self,
        root: &Path,
        files: &[String],
        rotation: &Rotation,
        options: &SyncOptions,
    ) {
        for path in files {
            let cached = self.cache.get(path).cloned();
            let Some((digest, stat)) = digest_of(
                &root.join(path),
                path,
                cached.as_ref(),
                rotation,
                options,
                &mut self.hashed_paths,
            ) else {
                self.skipped += 1;
                continue;
            };
            self.record_upsert(path, digest, stat, cached.as_ref());
        }
    }

    fn record_upsert(
        &mut self,
        path: &str,
        digest: String,
        stat: Stat,
        cached: Option<&FileState>,
    ) {
        let changed = cached.map(|entry| entry.digest != digest).unwrap_or(true);
        let revived = self.pending_tombstones.contains(path);
        if changed || revived {
            self.updates.push((
                path.to_string(),
                PendingChange {
                    kind: ChangeKind::Upsert,
                    digest: Some(digest.clone()),
                    generation: 0,
                },
            ));
        }
        let verified = cached.map(|entry| entry.verified_generation).unwrap_or(0);
        self.cache.insert(
            path.to_string(),
            FileState {
                digest,
                size: stat.size,
                mtime_us: stat.mtime_us,
                verified_generation: verified,
            },
        );
    }

    fn apply_tombstones(&mut self, tombstones: &[String]) {
        for path in tombstones {
            self.updates.push((
                path.clone(),
                PendingChange {
                    kind: ChangeKind::Tombstone,
                    digest: None,
                    generation: 0,
                },
            ));
            self.cache.remove(path);
        }
    }

    /// Stamp the generation, merge updates and return the new generation.
    fn finish(&mut self, state: &mut SyncState, next_cursor: usize) -> u64 {
        let generation = if self.updates.is_empty() {
            state.generation
        } else {
            state.generation + 1
        };
        for path in &self.hashed_paths {
            if let Some(entry) = self.cache.get_mut(path) {
                entry.verified_generation = generation;
            }
        }
        for (path, mut change) in std::mem::take(&mut self.updates) {
            change.generation = generation;
            match change.kind {
                ChangeKind::Upsert => self.upserts += 1,
                ChangeKind::Tombstone => self.tombstones += 1,
            }
            state.pending.insert(path, change);
        }
        state.files = std::mem::take(&mut self.cache);
        state.generation = generation;
        state.recheck_cursor = next_cursor;
        generation
    }

    fn outcome(&self, generation: u64, skipped: usize) -> SyncOutcome {
        SyncOutcome {
            generation,
            upserts: self.upserts,
            tombstones: self.tombstones,
            skipped: skipped + self.skipped,
            hashed: self.hashed_paths.len(),
            hashed_paths: self.hashed_paths.clone(),
        }
    }
}

/// Digest one file, or `None` when it must be skipped.
fn digest_of(
    full: &Path,
    path: &str,
    cached: Option<&FileState>,
    rotation: &Rotation,
    options: &SyncOptions,
    hashed_paths: &mut Vec<String>,
) -> Option<(String, Stat)> {
    let stat = digest::stat_of(full).ok()?;
    let reusable = cached
        .filter(|entry| entry.size == stat.size && entry.mtime_us == stat.mtime_us)
        .filter(|_| !rotation.due.contains(path));
    if let Some(entry) = reusable {
        return Some((entry.digest.clone(), stat));
    }
    match digest::inspect(full, options.max_file_bytes) {
        Ok(Content::Text(digest)) => {
            hashed_paths.push(path.to_string());
            Some((digest, stat))
        }
        Ok(_) | Err(_) => None,
    }
}

/// Which unchanged files the bounded rotation re-verifies this run.
struct Rotation {
    due: BTreeSet<String>,
    next_cursor: usize,
}

impl Rotation {
    fn plan(state: &SyncState, options: &SyncOptions) -> Self {
        let paths: Vec<&String> = state.files.keys().collect();
        if options.recheck_budget == 0 || paths.is_empty() {
            return Self {
                due: BTreeSet::new(),
                next_cursor: state.recheck_cursor,
            };
        }
        let start = state.recheck_cursor % paths.len();
        let mut due = BTreeSet::new();
        for offset in 0..paths.len() {
            if due.len() >= options.recheck_budget {
                break;
            }
            let path = paths[(start + offset) % paths.len()];
            let verified = state.files[path].verified_generation;
            if state.generation.saturating_sub(verified) >= options.recheck_age_generations {
                due.insert(path.clone());
            }
        }
        Self {
            due,
            next_cursor: (start + 1) % paths.len(),
        }
    }
}

/// Confirm that a batch was received and advance the watermark.
///
/// This is the seam a receipt handler calls once the server acknowledges a
/// generation; nothing in this client advances the watermark by itself.
pub fn confirm_receipt(store: &Store, generation: u64) -> Result<SyncState, SyncError> {
    let mut state = store.sync_state().map_err(SyncError::Store)?;
    if generation == 0 || generation > state.generation {
        return Err(SyncError::UnknownGeneration(generation));
    }
    state.confirm(generation);
    store.save_sync_state(&state).map_err(SyncError::Store)?;
    Ok(state)
}
