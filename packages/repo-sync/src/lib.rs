//! `retaindb-repo`: a small, on-demand client that reconciles Git state and
//! ships metadata batches outside the model loop.
//!
//! Module map:
//! - [`hint`]: validated event vocabulary (relative paths live here).
//! - [`adapters`]: client payload normalisation, one section per client.
//! - [`hook`]: the fail-open hook path.
//! - [`queue`]: bounded, atomic, file-backed hint queue.
//! - [`sync`]: Git-aware reconcile with digest cache.
//! - [`store`], [`sync_state`]: the state directory.
//! - [`cli`]: the four subcommands.

pub mod adapters;
pub mod atomic;
pub mod cli;
pub mod digest;
pub mod enrollment;
pub mod git;
pub mod hint;
pub mod hook;
pub mod inventory;
pub mod json;
pub mod policy;
pub mod queue;
pub mod sha256;
pub mod status;
pub mod store;
pub mod sync;
pub mod sync_state;
pub mod transport;

pub use hint::{Client, HintKind, HookHintV1, RelPath};
