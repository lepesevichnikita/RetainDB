//! Path and content policy: what never enters the index, and why.
//!
//! The exclusion list is explicit rather than inferred, because "generated" and
//! "vendor" are project conventions. Anything matched here is skipped without
//! reading it, and a skipped path never becomes a tombstone.

use std::fs;
use std::path::Path;

/// Directory names whose contents are generated or third-party.
pub const EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".turbo",
    ".next",
    ".nuxt",
    ".venv",
    ".idea",
    ".vscode",
    "__pycache__",
    "node_modules",
    "vendors",
    "vendor",
    "dist",
    "build",
    "target",
    "coverage",
    "Pods",
    "DerivedData",
];

/// File suffixes that are generated artefacts rather than source.
pub const EXCLUDED_SUFFIXES: &[&str] = &[".min.js", ".min.css", ".map", ".lock", ".snap", ".pb.go"];

/// File names that hold credentials by convention.
pub const SECRET_NAMES: &[&str] = &[
    ".env",
    ".env.local",
    ".env.production",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials.json",
    "secrets.json",
    "service-account.json",
];

/// File suffixes that hold credentials by convention.
pub const SECRET_SUFFIXES: &[&str] = &[
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".keystore",
    ".jks",
    ".pkcs12",
    ".kdbx",
];

/// Files that look secret-ish but are templates and safe to index.
pub const SECRET_EXCEPTIONS: &[&str] = &[".env.example", ".env.sample", ".env.template"];

/// Byte markers of a pasted credential inside an otherwise ordinary file.
pub const SECRET_MARKERS: &[&[u8]] = &[
    b"-----BEGIN RSA PRIVATE KEY-----",
    b"-----BEGIN OPENSSH PRIVATE KEY-----",
    b"-----BEGIN EC PRIVATE KEY-----",
    b"-----BEGIN PGP PRIVATE KEY BLOCK-----",
    b"aws_secret_access_key",
];

/// Bytes inspected for the cheap binary probe.
pub const SAMPLE_BYTES: usize = 8 * 1024;

/// Why a candidate path was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skip {
    /// Generated/vendor path or credential name.
    Excluded,
    /// A symlink in the path, or a symlinked file.
    Symlink,
    /// Not a regular file (directory, socket, device, submodule worktree).
    Special,
    /// Cannot be inspected (permissions, vanished parent).
    Unreadable,
    /// Above the size limit.
    Oversized,
    /// Contains a NUL byte in the first block.
    Binary,
    /// Looks like it contains a credential.
    Secret,
}

/// Is this path excluded by name alone?
pub fn is_excluded(relative: &str) -> bool {
    let name = file_name(relative);
    if SECRET_EXCEPTIONS.contains(&name) {
        return false;
    }
    relative
        .split('/')
        .any(|component| EXCLUDED_DIRS.contains(&component))
        || EXCLUDED_SUFFIXES
            .iter()
            .any(|suffix| name.ends_with(suffix))
        || SECRET_NAMES.contains(&name)
        || SECRET_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/// Last path component.
pub fn file_name(relative: &str) -> &str {
    relative.rsplit('/').next().unwrap_or(relative)
}

/// Cheap binary probe on the first block of a file.
pub fn is_binary(sample: &[u8]) -> bool {
    sample.contains(&0)
}

/// Does this sample contain a credential marker?
pub fn looks_like_secret(sample: &[u8]) -> bool {
    SECRET_MARKERS.iter().any(|marker| contains(sample, marker))
}

/// Longest marker; a marker can straddle two reads, so a streaming scan has to
/// carry one byte less than this across a chunk boundary.
pub fn max_marker_len() -> usize {
    SECRET_MARKERS
        .iter()
        .map(|marker| marker.len())
        .max()
        .unwrap_or(0)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Check every path component: no symlinks, a regular file at the end, within
/// the size limit. Reads metadata only, never content.
pub fn check_path(root: &Path, relative: &str, max_bytes: u64) -> Result<(), Skip> {
    let components: Vec<&str> = relative.split('/').collect();
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|_| Skip::Unreadable)?;
        let last = index + 1 == components.len();
        check_component(&metadata, last)?;
    }
    let metadata = fs::symlink_metadata(&current).map_err(|_| Skip::Unreadable)?;
    if metadata.len() > max_bytes {
        return Err(Skip::Oversized);
    }
    Ok(())
}

fn check_component(metadata: &fs::Metadata, last: bool) -> Result<(), Skip> {
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Err(Skip::Symlink);
    }
    if last {
        return if file_type.is_file() {
            Ok(())
        } else {
            Err(Skip::Special)
        };
    }
    if file_type.is_dir() {
        Ok(())
    } else {
        Err(Skip::Special)
    }
}

/// Is the path confirmed absent (as opposed to unreadable)?
pub fn confirmed_absent(root: &Path, relative: &str) -> bool {
    matches!(fs::symlink_metadata(root.join(relative)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}
