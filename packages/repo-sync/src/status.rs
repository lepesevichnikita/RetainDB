//! `status`: the operator's view of one enrollment, as plain `key=value` lines.

use std::path::{Path, PathBuf};

use crate::store::{Store, StoreError};

/// Everything `status` prints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub root: PathBuf,
    pub aliases: Vec<PathBuf>,
    pub queue_depth: usize,
    pub overflow: bool,
    pub watermark: u64,
    pub pending: usize,
    pub generation: u64,
}

impl Report {
    /// Render as `key=value` lines, in a stable order.
    pub fn lines(&self) -> Vec<String> {
        vec![
            format!("root={}", self.root.display()),
            format!("queue_depth={}", self.queue_depth),
            format!("overflow={}", self.overflow),
            format!("last_confirmed_generation={}", self.watermark),
            format!("pending={}", self.pending),
            format!("generation={}", self.generation),
        ]
    }

    /// Does `candidate` name the enrolled root (including its aliases)?
    pub fn matches(&self, candidate: &Path) -> bool {
        candidate == self.root || self.aliases.iter().any(|alias| alias == candidate)
    }
}

/// Read the enrollment, queue and reconcile state.
pub fn report(store: &Store) -> Result<Report, StoreError> {
    let enrollment = store.enrollment()?;
    let queue = store
        .queue()
        .map_err(|error| StoreError::Corrupt(error.to_string()))?;
    let state = store.sync_state()?;
    Ok(Report {
        root: enrollment.root,
        aliases: enrollment.aliases,
        queue_depth: queue.depth(),
        overflow: queue.overflow(),
        watermark: state.watermark,
        pending: state.pending_count(),
        generation: state.generation,
    })
}
