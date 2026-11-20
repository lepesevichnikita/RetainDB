//! Primitives the rest of the crate stands on: SHA-256 vectors, the JSON
//! reader/writer, and the relative-path trust boundary.

use retaindb_repo::hint::RelPath;
use retaindb_repo::json;
use retaindb_repo::sha256;

#[test]
fn sha256_of_abc_matches_fips_180_vector() {
    // FIPS 180-4 example; proves the digest is real SHA-256, not a stub.
    assert_eq!(
        sha256::hex_digest(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn sha256_of_empty_input_matches_fips_180_vector() {
    // The padding path for zero-length input is a classic off-by-one bug.
    assert_eq!(
        sha256::hex_digest(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn sha256_of_two_block_message_matches_vector() {
    // 56-byte input exercises the extra padding block.
    let msg = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    assert_eq!(
        sha256::hex_digest(msg),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
}

#[test]
fn streaming_sha256_equals_one_shot_digest() {
    // The file hasher feeds chunks, so chunking must not change the digest.
    let mut hasher = sha256::Sha256::new();
    hasher.update(b"abcdbcdecdefdefge");
    hasher.update(b"fghfghighijhijkijkljklmklmnlmnomnopnopq");
    assert_eq!(
        sha256::hex(&hasher.finish()),
        sha256::hex_digest(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
    );
}

#[test]
fn json_reads_nested_field() {
    // Hook events nest tool_input.file_path two levels deep.
    let value = json::parse(r#"{"tool_input":{"file_path":"src/main.rs"}}"#).expect("parses");
    let inner = value.get("tool_input").expect("tool_input");
    assert_eq!(
        inner.get("file_path").and_then(|v| v.as_str()),
        Some("src/main.rs")
    );
}

#[test]
fn json_reads_numbers_and_bools() {
    // schema_version and status flags are scalars.
    let value = json::parse(r#"{"schema_version":1,"ok":true}"#).expect("parses");
    assert_eq!(
        value.get("schema_version").and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(value.get("ok").and_then(|v| v.as_bool()), Some(true));
}

#[test]
fn json_decodes_escapes() {
    // Paths with spaces/quotes arrive escaped; a broken decoder misreads them.
    let value = json::parse(r#"{"path":"a b\\c\u0022d"}"#).expect("parses");
    assert_eq!(
        value.get("path").and_then(|v| v.as_str()),
        Some("a b\\c\"d")
    );
}

#[test]
fn json_rejects_trailing_garbage() {
    // Two events on one stdin read must not silently merge.
    assert!(json::parse(r#"{"a":1} trailing"#).is_err());
}

#[test]
fn json_rejects_truncated_input() {
    // A hook killed mid-write must not be read as a valid event.
    assert!(json::parse(r#"{"a":{"b":1}"#).is_err());
}

#[test]
fn json_roundtrips_through_encode() {
    // State files are written and read back by the same codec.
    let text = r#"{"generation":2,"files":{"a.txt":{"digest":"ff","pending":true}}}"#;
    let value = json::parse(text).expect("parses");
    assert_eq!(json::parse(&value.encode()).expect("reparses"), value);
}

#[test]
fn json_decodes_a_surrogate_pair() {
    // U+1F600 arrives as \uD83D\uDE00; a broken pair join loses the character.
    let value = json::parse(r#"{"emoji":"\uD83D\uDE00"}"#).expect("parses");
    assert_eq!(value.get("emoji").and_then(|v| v.as_str()), Some("😀"));
}

#[test]
fn json_rejects_an_unpaired_surrogate() {
    // A lone high surrogate is not a character.
    assert!(json::parse(r#"{"emoji":"\uD83D"}"#).is_err());
}

#[test]
fn json_reads_multibyte_utf8_paths() {
    // Repositories contain non-ASCII paths; the decoder must not mangle them.
    let value = json::parse(r#"{"path":"src/тест/файл.rs"}"#).expect("parses");
    assert_eq!(
        value.get("path").and_then(|v| v.as_str()),
        Some("src/тест/файл.rs")
    );
}

#[test]
fn json_reads_a_long_string() {
    // A 60 KiB string is inside the hook cap; parsing must stay linear.
    let long = "x".repeat(60 * 1024);
    let text = format!(r#"{{"pad":"{long}"}}"#);
    let value = json::parse(&text).expect("parses");
    assert_eq!(
        value.get("pad").and_then(|v| v.as_str()).map(str::len),
        Some(60 * 1024)
    );
}

#[test]
fn relpath_accepts_nested_relative_path() {
    // The normal case: a read inside the enrolled repository.
    let path = RelPath::parse("packages/repo-sync/src/main.rs").expect("accepted");
    assert_eq!(path.as_str(), "packages/repo-sync/src/main.rs");
}

#[test]
fn relpath_rejects_absolute_path() {
    // Absolute paths escape the enrollment root and must never be trusted.
    assert!(RelPath::parse("/etc/passwd").is_err());
    assert!(RelPath::parse("/Users/someone/repo/src/main.rs").is_err());
}

#[test]
fn relpath_rejects_parent_traversal() {
    // `..` in any position can walk out of the root.
    assert!(RelPath::parse("../secret").is_err());
    assert!(RelPath::parse("src/../../secret").is_err());
    assert!(RelPath::parse("src/..").is_err());
}

#[test]
fn relpath_rejects_empty_dot_and_double_separators() {
    // Empty components make a path ambiguous for every later consumer.
    assert!(RelPath::parse("").is_err());
    assert!(RelPath::parse(".").is_err());
    assert!(RelPath::parse("src//main.rs").is_err());
    assert!(RelPath::parse("src/./main.rs").is_err());
    assert!(RelPath::parse("src/main.rs/").is_err());
}

#[test]
fn relpath_rejects_backslash_and_drive_letters() {
    // A Windows-style separator or drive prefix means the event is not a repo path.
    assert!(RelPath::parse("src\\main.rs").is_err());
    assert!(RelPath::parse("C:/Users/x/main.rs").is_err());
    assert!(RelPath::parse("c:main.rs").is_err());
}

#[test]
fn relpath_rejects_control_characters() {
    // NUL lets a path be truncated by any C consumer downstream.
    assert!(RelPath::parse("src/main\0.rs").is_err());
    assert!(RelPath::parse("src/ma\nin.rs").is_err());
}
