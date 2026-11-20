//! Bounded content inspection: one pass over the file produces the SHA-256
//! digest and the binary/secret verdict from the same bytes.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::policy::{self, Skip};
use crate::sha256::Sha256;

/// Read size per syscall; small enough to bound memory, large enough to be fast.
const CHUNK: usize = 64 * 1024;

/// What the content turned out to be.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Content {
    /// Indexable text with this digest.
    Text(String),
    /// Contains a NUL byte in the first block.
    Binary,
    /// Contains a credential marker.
    Secret,
}

/// Stat identity used by the digest cache.
///
/// The timestamp is kept in microseconds, not nanoseconds: the state file is
/// JSON and this writer stores numbers as f64, which cannot represent a
/// nanosecond epoch exactly. A microsecond collision on the same file size is
/// what the bounded rotating recheck exists to catch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stat {
    pub size: u64,
    pub mtime_us: u64,
}

/// Read metadata into the cache key form.
pub fn stat_of(path: &Path) -> Result<Stat, Skip> {
    let metadata = fs::symlink_metadata(path).map_err(|_| Skip::Unreadable)?;
    Ok(Stat {
        size: metadata.len(),
        mtime_us: mtime_us(&metadata),
    })
}

/// Modification time in microseconds since the Unix epoch.
pub fn mtime_us(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| (age.as_nanos() / 1_000) as u64)
        .unwrap_or(0)
}

/// Hash a file in one bounded pass, classify its first block as binary and
/// scan every byte for a credential marker.
///
/// The size limit is enforced before anything is read, so an oversized file is
/// refused without streaming it.
pub fn inspect(path: &Path, max_bytes: u64) -> Result<Content, Skip> {
    let file = fs::File::open(path).map_err(|_| Skip::Unreadable)?;
    let metadata = file.metadata().map_err(|_| Skip::Unreadable)?;
    if metadata.len() > max_bytes {
        return Err(Skip::Oversized);
    }
    let mut sample = Vec::with_capacity(policy::SAMPLE_BYTES);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut file = file;
    // A marker can straddle two reads, so the scan keeps the tail of the last
    // chunk. Secrets are not confined to the first block: a key pasted after
    // 8 KiB would otherwise be hashed and indexed.
    let overlap = policy::max_marker_len().saturating_sub(1);
    let mut carry = Vec::new();
    let mut secret = false;
    loop {
        let read = file.read(&mut buffer).map_err(|_| Skip::Unreadable)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        hasher.update(chunk);
        if sample.len() < policy::SAMPLE_BYTES {
            let take = (policy::SAMPLE_BYTES - sample.len()).min(chunk.len());
            sample.extend_from_slice(&chunk[..take]);
        }
        if !secret {
            carry.extend_from_slice(chunk);
            secret = policy::looks_like_secret(&carry);
            if carry.len() > overlap {
                carry.drain(..carry.len() - overlap);
            }
        }
    }
    if policy::is_binary(&sample) {
        return Ok(Content::Binary);
    }
    if secret {
        return Ok(Content::Secret);
    }
    Ok(Content::Text(crate::sha256::hex(&hasher.finish())))
}
