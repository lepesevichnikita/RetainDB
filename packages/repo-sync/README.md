# `packages/repo-sync` — `retaindb-repo`

A small, on-demand Rust client that turns coding-agent activity into metadata
batches. It is not a daemon, holds no vector index, runs no embedding, and never
stores a file body.

This slice covers enrollment, hook hints, a bounded queue, the Git-aware
reconcile pass, and the outbound batch transport that ships the unconfirmed
changes of a generation and consumes the receipt.

## Build

```bash
cargo fmt --manifest-path packages/repo-sync/Cargo.toml --check
cargo clippy --manifest-path packages/repo-sync/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path packages/repo-sync/Cargo.toml
```

No dependencies. `Cargo.toml` is self-contained (edition 2021, explicit
version), `Cargo.lock` ships with the crate (so `--locked` builds are
reproducible), and SHA-256 plus the JSON reader/writer are implemented in-tree,
so `cargo build --offline` works on a machine with no crates.io access (`cargo
build --offline --locked` exits 0). `packages/repo-sync` is not an npm package and has no
`package.json`, so the pnpm workspace is unaffected.

## Commands

```
retaindb-repo enroll --root <abs path>
retaindb-repo hook   --client <claude|codex|hermes>
retaindb-repo sync   --root <abs path>
retaindb-repo status --root <abs path>
```

Exit codes: `0` success or fail-open, `1` operation failed (bad root, not a Git
work tree, foreign root, unreadable state), `2` usage error (unknown
subcommand, unknown flag, missing flag value).

`hook` is the exception: every failure mode inside it returns `0`. A hook that
exits non-zero can block the client's tool call, so unknown client, unknown
schema, bad path, oversized input and malformed JSON all fail open with nothing
queued. Stdin is always read to the end, even for an event the hook refuses:
exiting before the payload is consumed would surface at the client as a broken
pipe, which is a failed tool call even though the hook exited `0`.

### State directory

Default `$HOME/.local/state/retaindb-repo`, overridable with
`RETAINDB_REPO_STATE_DIR`.

| File | Contents |
| --- | --- |
| `enrollment.json` | local `enrollment_id`, canonical root, root aliases |
| `queue.json` | bounded hint queue, at most `MAX_HINTS` (256) records |
| `sync.json` | receipt watermark, generation, digest cache, pending changes |

Every write is temp file + `fsync` + rename, so a reader sees the old document
or the new one, never a partial one. The directory is created `0700` and every
state file is created `0600`: hints name repository paths, so they are for the
owning user only.

## Hook

One JSON event on stdin, at most 64 KiB buffered, at most one queued hint.
Nothing on stdout on success; a one-line note on stderr when an event is
ignored. A larger payload is refused, then drained to the end of the pipe.

The hook never opens the file a hint names. Path validation is purely lexical
(`RelPath`), which is what makes a hint for a not-yet-created or unreadable file
safe. Symlink resolution is deliberately *not* done here: the reconcile pass
re-checks every component on disk before hashing.

Normalised record (`HookHintV1`): locally trusted `enrollment_id`, `client`,
`adapter_version`, `kind = file_read|reconcile`, one validated relative path for
`file_read` (at most 4096 bytes), optional opaque `correlation_id` (at most 256
bytes). A path or id over the cap is a refused event, never a truncated field:
the queue file is rewritten in full per event, so one 60 KB "path" would cost
60 KB of state on every later write.

### Client event shapes

**Claude Code** — `PostToolUse` for the `Read` tool, from the Claude Code hooks
reference:

```json
{"session_id":"...","hook_event_name":"PostToolUse","tool_name":"Read",
 "tool_input":{"file_path":"/abs/repo/src/main.rs"},
 "tool_use_id":"toolu_01...","cwd":"/abs/repo"}
```

`tool_input.file_path` is absolute; it is resolved lexically against the
enrolled root (canonical path or an alias), then validated as relative.
`tool_use_id` becomes `correlation_id`.

**Hermes** — `post_tool_call` for `read_file`:

```json
{"tool_name":"read_file","tool_input":{"path":"src/main.rs"},"cwd":"/abs/repo",
 "extra":{"status":"success","result":{"content":"...encoded..."}}}
```

Only `tool_input.path` and `extra.status` are read. `extra.result` is opaque and
never decoded, stored or hashed. A non-`success` status queues nothing.

**Codex** — lifecycle only (`SessionStart`, `Stop`), mapped to
`kind = reconcile`. Codex exposes no per-file read event with a trustworthy
path, so a `file_read`-shaped Codex payload is rejected rather than guessed at.

## Reconcile (`sync`)

Two read-only subprocesses, both NUL-separated:

- `git ls-tree -r -z --full-tree HEAD` for tracked entries;
- `git status --porcelain -z --untracked-files=all` for working-tree changes
  (`.gitignore` is applied by Git; `--untracked-files=all` is required or Git
  collapses a whole untracked directory into `?? dir/`).

`GIT_OPTIONAL_LOCKS=0` keeps `git status` from rewriting the index.

Refused before any content is read: excluded directories and suffixes,
credential file names and suffixes, symlinks (in any path component),
submodules/gitlinks, non-regular files, files above `max_file_bytes` (1 MiB).

A record whose path bytes are not valid UTF-8 is counted in `skipped` and
dropped on its own; it does not abort the pass, so one such name cannot disable
sync for the rest of the repository.

Refused after inspecting the first 8 KiB: binary content (a NUL byte).
Suspected secrets (`-----BEGIN … PRIVATE KEY-----`, `aws_secret_access_key`) are
scanned in every chunk with a marker-length overlap, so a key pasted after the
first block is refused too and no digest of it is stored.

Exclusion list: `.git .hg .svn .turbo .next .nuxt .venv .idea .vscode
__pycache__ node_modules vendors vendor dist build target coverage Pods
DerivedData`, suffixes `.min.js .min.css .map .lock .snap .pb.go`, names
`.env .env.local .env.production .npmrc .netrc .git-credentials id_rsa id_dsa
id_ecdsa id_ed25519 credentials.json secrets.json service-account.json`,
suffixes `.pem .key .p12 .pfx .keystore .jks .pkcs12 .kdbx`. `.env.example`,
`.env.sample` and `.env.template` are exempt.

### Digests

SHA-256 over the content, computed in one streaming pass that also yields the
binary/secret verdict. The cache key is `(size, mtime in microseconds)`. A hit
skips hashing; a miss hashes once.

- Microseconds, not nanoseconds: state is JSON and this writer stores numbers as
  `f64`, which cannot represent a nanosecond epoch exactly. A same-size edit
  inside one microsecond is caught by the rotation below.
- Bounded rotating recheck: at most `recheck_budget` (8) unchanged files are
  re-verified per run, and only files whose content has not been verified for
  `recheck_age_generations` (64) generations. Unchanged files are therefore not
  rehashed every run, but drift is still caught eventually.

### Changes, tombstones, watermark

- `upsert` = path exists with this digest; `tombstone` = path is gone.
- A working-tree deletion needs an explicit Git signal (deleted, or renamed away)
  plus a confirmed `lstat` absence. A committed deletion has only one signal
  left: after `git commit` the path is in neither the pinned HEAD tree nor
  `git status`, so absence from the HEAD tree, checked against the previously
  confirmed set, plus the same confirmed absence, is what retires it. Neither
  source deletes anything on an unreadable path, a policy skip, or a failed
  listing: a path that is still on disk keeps its entry.
- A failed or interrupted inventory aborts the run before any state is written.
- A rename yields an upsert for the new name and a tombstone for the old one in
  the same generation, except for a half that the path policy refuses.
- Offline edits coalesce: the pending map holds the latest state per path, never
  a history.
- The generation advances only when a run produces at least one change.
- The receipt watermark (`last_confirmed_generation`) advances only through
  `sync::confirm_receipt(store, generation)`, which `transport::deliver` calls
  with the generation a parsed receipt names. `sync` itself never moves it, so
  `pending` is honest until the server confirms a batch.

## Transport

`transport::deliver` ships every unconfirmed change of the stored generation as
one bounded request and advances the watermark to the generation in the
returned receipt. Nothing is sent when `pending` is empty.

```
POST $RETAINDB_REPO_INDEX_URL
x-retaindb-repo-index-grant: $RETAINDB_REPO_INDEX_GRANT
{"enrollment_id":"enr_…","generation":4,"part_no":1,
 "changes":[{"path":"src/main.rs","kind":"upsert","digest":"…"}]}
→ 200 {"generation":4}
```

The credential comes from the environment only: it is not a command-line flag,
never written to the queue or `sync.json`, and the type that holds it has a
redacted `Debug` and no `Display`, so no message can print it.

`curl` is the sender: std-only, offline-buildable, spawned directly (no shell).
`--proto '=https,http'` keeps an env-supplied URL from reading local files, and
`--location` is deliberately absent so a redirect cannot carry the grant header
to another host. stdout is `<body>\n<status>`, so the status is parsed without a
second request.

Bounds are checked before the request leaves: `max_entries` (512) and
`max_wire_bytes` (256 KiB) in `Limits`. An oversized batch is refused locally
rather than uploaded and bounced with a 413.

| Outcome | Handling |
| --- | --- |
| 2xx with a parsable `{"generation":N}` | watermark advances to `N`, nothing is retried |
| 413 | `TooLarge`, no retry: the same body cannot shrink |
| 401, 403 | `Denied`, no retry: a refused grant does not heal |
| other 4xx, 3xx | `Rejected`, no retry |
| 429, 5xx | retried with doubling backoff, bounded by `max_attempts` (3), then `Exhausted` |
| no response (DNS, TCP, TLS, timeout) | retried the same way, then `Lost` |
| `curl` missing | `Unavailable`, no retry |

Every retry resends the identical body and part number, so a batch whose
response was lost is applied once: the part number is the server's
deduplication key. A lost response alone never moves the watermark, because only
a parsed receipt does.

`transport::Transport` is the seam a different sender can implement; the shipped
implementation is `transport::CurlTransport`. The tests drive a fake through the
same trait, so no test opens a socket or runs `curl`.

## `status`

```
root=/abs/repo
queue_depth=3
overflow=false
last_confirmed_generation=0
pending=2
generation=2
```

`--root` must name the enrolled root (canonical or alias); anything else exits 1
instead of reporting another repository's state.

## Durability trade-off (recorded, not hidden)

A SQLite binding could not be shown to build offline, so the queue and reconcile
state are JSON files replaced atomically. The hook writes through the small
`HintSink` trait and `FileQueue` is its only implementation, so a transactional
backend can replace it without touching the hook. That gives crash safety for a single
document and no partial writes, but not multi-file transactions: `queue.json`
and `sync.json` are independent documents. Concurrency is single-writer; the
hook is a short-lived process and both files are small and bounded (queue: 256
hints max, each naming a path of at most 4096 bytes; state: one entry per
indexed file).

The queue is bounded on purpose: while offline, new distinct hints beyond the
cap set `overflow=true` and are dropped, while a hint for an already-queued path
still coalesces. The cap is enforced on load as well as on enqueue, so a
`queue.json` written under an older (or no) cap is trimmed to `MAX_HINTS` when
read, keeping the oldest records, and `overflow` is set. `status` surfaces the
flag so a sender can drain and clear it.

## Not in this slice

- Draining the hint queue: the transport ships the reconcile change set, and the
  hook queue still has no sender of its own.
- Publishing a repo-index attempt: no open-attempt, part-numbered multi-part
  upload or finalize call; `deliver` sends one part per generation.
- A daemon/scheduler; every command is on-demand.
- Local vector index or embedding.
