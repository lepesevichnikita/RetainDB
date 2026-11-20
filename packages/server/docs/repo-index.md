# Repository index

The Server side of repository indexing: enrolling a worktree, publishing a generation of path
metadata, materialising that generation into searchable chunks, and reading it back. The Rust
client that produces the metadata is documented separately in
[`packages/repo-sync/README.md`](../../repo-sync/README.md).

Unreleased, and not verified end to end. The migration has been applied to a real PostgreSQL 16
with pgvector 0.8.7 (75 tables, including all five `repo_index_*` tables), and the DB-gated tests
now execute against a database instead of skipping: with `RETAINDB_TEST_DATABASE_URL` pointing at
that database and `RETAINDB_TEST_LOCAL_EMBEDDINGS=true`, the full server suite reports 323 tests,
323 pass, 0 fail, 0 skipped. Both variables are needed: without the second, the embedding-backed
cases skip, and a skipped case is not a passing one. Read
[Operational status](#operational-status) before relying on any of it.

## Where the code is

| Piece | File |
| --- | --- |
| Admin routes: enrol, mint, revoke, pause, resume, withdraw | `packages/server/src/api/repo-index-admin.ts` |
| Data-plane routes: attempt, parts, finalize, abandon, receipt, manifest | `packages/server/src/api/repo-index.ts` |
| Publication fence (pure functions, no I/O) | `packages/server/src/engine/repo-index/receipt.ts` |
| Persistence, cursors, transaction boundaries | `packages/server/src/engine/repo-index/store.ts` |
| Materialisation into `sources`, `documents`, `chunks` | `packages/server/src/engine/repo-index/materialise.ts` |
| Committed-ref reader (pure over an injected provider) | `packages/server/src/connectors/repo-ref.ts` |
| `RefProvider` over an on-disk git repository (`createGitRefProvider`) | `packages/server/src/connectors/ref-provider-git.ts` |
| The run that ties a committed ref to one publication | `packages/server/src/engine/repo-index/connector-run.ts` |
| Grant token mint and hash | `packages/server/src/engine/repo-index/grant-token.ts` |
| Migration | `packages/server/prisma/migrations/20261120120500_repo_index_indexing/migration.sql` |

Both routers are mounted on the API app in `packages/server/src/api/routes.ts`. Every route is
behind `authMiddleware` (`api.use("/*", authMiddleware)` in the same file), so when
`RETAINDB_API_KEY` is set, every call below also needs `Authorization: Bearer <key>`. The grant
token is a second, separate credential carried in `X-RetainDB-Repo-Index-Grant`.

## What this is, and what it deliberately does not do

It is a scoped publication pipeline: one worktree of one repository, owned by one project, is
enrolled as a scope; a caller declares an attempt, uploads the attempt's parts, and a publication
fence decides whether that attempt may replace the generation readers currently see. A published
generation can be materialised into ordinary `chunks` rows so semantic search can return a file
by path.

What it does not do:

- **No daemon.** Nothing in the Server runs on a timer for this feature. The Rust client is
  on-demand too: "A daemon/scheduler; every command is on-demand" is listed as out of scope in
  `packages/repo-sync/README.md`.
- **No local vector index.** The client "holds no vector index, runs no embedding, and never
  stores a file body" (`packages/repo-sync/README.md`).
- **No local embedding runtime on the client.** The client has no embedding code at all; vectors
  are produced on the Server by `packages/server/src/engine/embeddings.ts`, called from
  `materialise.ts`.
- **No duplicate copy of the repository on the client.** The client stores paths and digests.
  The Server does store text: materialisation writes one `documents` row per path including
  `content` (`documentData` in `materialise.ts`), because chunking and search read from it. That
  is the only copy of file text this feature writes.
- **Hooks only signal.** A client hook validates a path lexically, queues at most one hint, and
  never opens the file it names (`packages/repo-sync/README.md`, "Hook"). A hint is a signal, not
  a read, an upload or a publication.
- **The cluster is authoritative.** Scope state, generations, parts, paths, receipts and chunks
  live in PostgreSQL. Nothing a client holds is consulted when a publication, a read or a search
  is answered; the fence (`receipt.ts`) and the store (`store.ts`) read database rows only.

## Enrolment walkthrough

Enrolment is admin work. All six admin routes call `requireCredential`, which refuses with
`403 ADMIN_REQUIRED` unless `authMiddleware` recorded `authType: "api_key"`. `authMiddleware`
records `"open"` when `RETAINDB_API_KEY` is unset (`packages/server/src/middleware/auth.ts`), so a
keyless deployment can serve every read path in the product but cannot enrol a worktree or mint a
grant. Set `RETAINDB_API_KEY` on the Server and send the same key as `Authorization: Bearer <key>`.

The `projectId` in the enrolment body is resolved inside the caller's org, by uuid, name or slug
(`resolveProjectReference` in `packages/server/src/api/helpers.ts`). A project the org does not own
answers `404 PROJECT_NOT_FOUND`; the body never carries authority.

1. Create the scope. `POST /v1/repo-index/admin/scopes`:

   ```bash
   curl -X POST "$RETAINDB_BASE_URL/v1/repo-index/admin/scopes" \
     -H "Authorization: Bearer $RETAINDB_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "projectId": "<project uuid, name or slug>",
       "repoHost": "github.com",
       "repoExternalId": "<the forge repository id>",
       "worktreePath": "/Users/me/src/repo",
       "deviceId": "<stable device identifier>",
       "ref": "refs/heads/main",
       "headCommit": "<commit sha>",
       "policyVersion": "<policy version>",
       "pipelineVersion": "<pipeline version>"
     }'
   ```

   All nine fields are required (`scopeRequestSchema`). `repoHost` is lowercased, `worktreePath`
   has trailing separators stripped (a Windows drive root keeps its separator), and
   `repoExternalId` keeps its case. The response is `201` with `code: "SCOPE_CREATED"` and
   `scope.id`, which every later call uses as the path parameter. The new scope is `active` with
   `activeGeneration: 0`.

   Scope identity is unique on `(orgId, repoHost, repoExternalId, worktreePath)`. A duplicate
   answers `409 SCOPE_DUPLICATE` and includes the blocking scope, so an operator whose worktree
   was paused or withdrawn earlier can see which row owns the identity instead of guessing.

2. Mint one grant per holder and kind. `POST /v1/repo-index/admin/scopes/:scopeId/grants`:

   ```bash
   curl -X POST "$RETAINDB_BASE_URL/v1/repo-index/admin/scopes/<scopeId>/grants" \
     -H "Authorization: Bearer $RETAINDB_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"kind": "uploader", "principal": "ci-runner"}'
   ```

   `kind` is one of `reader`, `uploader`, `connector`, `admin`; `principal` is any non-empty label
   up to 256 characters. The response is `201` with `code: "GRANT_CREATED"`, the grant row, and a
   `token` field. The scope must be `active` to mint; any other state answers
   `409 SCOPE_NOT_ACTIVE`.

   **Minting is bounded by what the caller can itself present.** `reader`, `uploader` and
   `connector` can be minted with the deployment key, because none of them can publish. `admin`
   is a promoting kind (`PROMOTION_KINDS` in `repo-index-admin.ts`, the kinds `repo-index.ts`
   accepts for finalize and abandon), so it is minted only for a caller that presents a live
   `admin` grant for the same scope in `X-RetainDB-Repo-Index-Grant`. Anyone else — including a
   request authenticated solely by the deployment key — gets `403 GRANT_KIND_REFUSED`, and the
   refusal is decided before the insert so no row is written. An uploader therefore cannot mint
   itself the capability to publish its own upload.

   **The first `admin` grant of a scope is provisioned out of band**, as one live row whose
   `tokenHash` is the sha256 of a token the operator generates and keeps. There is deliberately no
   HTTP request that creates it: a route able to mint the first admin grant would be the same
   escalation path this rule closes.

3. **The token's plaintext appears exactly once, in that response.** A token is 128 random bits as
   hex (`mintGrantToken` in `grant-token.ts`); only the sha256 of its plaintext reaches the
   database, and `serializeGrant` in `repo-index-admin.ts` omits `tokenHash` from every response.
   A data-plane call resolves a grant by `tokenHash` and nothing else, so a lost token cannot be
   recovered, only revoked and re-minted. The same `(scopeId, kind, principal)` can hold one live
   grant: a second mint answers `409 GRANT_DUPLICATE` with the blocking grant, and a revoked row
   does not block a new one (partial unique index `repo_index_grants_live_principal_key` in the
   migration).

4. Hand each token to its holder out of band.

5. Later: `POST .../grants/:grantId/revoke` answers `200 GRANT_REVOKED`, or
   `200 GRANT_ALREADY_REVOKED` on a retry, because the update is fenced on `revokedAt: null`.

6. Scope lifecycle. The state machine in `repo-index-admin.ts` is chosen so no transition can
   leave the terminal state:

   | From | Action | To | Codes |
   | --- | --- | --- | --- |
   | `active` | pause | `paused` | `PAUSE_APPLIED` |
   | `paused` | resume | `active` | `RESUME_APPLIED` |
   | `active`, `paused` | withdraw | `withdrawn` | `WITHDRAW_APPLIED` |
   | `paused` | pause | `paused` | `PAUSE_ALREADY_APPLIED` |
   | `active` | resume | `active` | `RESUME_ALREADY_APPLIED` |
   | `withdrawn` | withdraw | `withdrawn` | `WITHDRAW_ALREADY_APPLIED` |
   | `withdrawn` | pause | - | `409 PAUSE_REFUSED_WITHDRAWN` |
   | `withdrawn` | resume | - | `409 RESUME_REFUSED_WITHDRAWN` |

   A paused scope serves and accepts nothing; its grants survive, so resume is the documented way
   back. Withdraw is terminal. A transition that loses a race to a competing writer answers from
   the state that actually committed, never from its own stale read (`applyScopeTransition`).

## Grant kinds and capabilities

Capability is a table in `repo-index.ts` (`CAPABILITY`), and the routes read that table and
nothing else:

| Route | Capability | Grant kinds it accepts |
| --- | --- | --- |
| `PUT /v1/repo-index/scopes/:scopeId/generations/:attemptId` | `OPEN_ATTEMPT` | `uploader`, `connector` |
| `PUT /v1/repo-index/scopes/:scopeId/generations/:attemptId/parts/:partNo` | `PUT_PART` | `uploader`, `connector` |
| `POST /v1/repo-index/scopes/:scopeId/generations/:attemptId/finalize` | `FINALIZE` | `admin` |
| `POST /v1/repo-index/scopes/:scopeId/generations/:attemptId/abandon` | `ABANDON` | `admin` |
| `GET /v1/repo-index/scopes/:scopeId/receipt` | `READ_RECEIPT` | `reader`, `connector` |
| `GET /v1/repo-index/scopes/:scopeId/manifest` | `READ_MANIFEST` | `reader`, `connector` |

What that means per kind:

| Kind | May | May not |
| --- | --- | --- |
| `reader` | read the receipt and the manifest | declare an attempt, write a part, publish, abandon |
| `uploader` | open an attempt, write its parts | read the manifest or receipt, publish, abandon |
| `connector` | open an attempt, write its parts, read the receipt and the manifest | publish, abandon |
| `admin` | publish, abandon | open an attempt, write a part, read the manifest or receipt |

Two consequences worth stating plainly. An `uploader` cannot promote its own upload, and a
`connector` cannot either: only an admin grant may finalize or abandon. And an `admin` grant
cannot read what it publishes, because no read capability lists it; a deployment that wants one
operator to publish and inspect needs both an `admin` and a `reader` grant.

How a call is authorised (`authorize` in `repo-index.ts`): the token from
`X-RetainDB-Repo-Index-Grant` is hashed and looked up among live grants (`revokedAt: null`) of
that scope whose `kind` is in the capability's list. No token, an unknown token, a wrong kind and
a revoked grant all answer `403 GRANT_MISSING`, so the route cannot be used to probe for grants.
Every capability then additionally requires the scope itself to be active: `409 SCOPE_PAUSED`,
`403 SCOPE_WITHDRAWN`, or `403 SCOPE_REVOKED` for a state `scopeStatusOf` does not know. Those
codes come from `scopeRefusal` in `receipt.ts`, which the store and the fence ask as well, so a
paused scope is never reported as revoked and a withdrawal is never reported as a pause.

The ready-made run in `connector-run.ts` does not use these routes: it calls the store functions
in-process, so a `connector` token is what a sync worker needs to read a published tree over HTTP,
not what publishes a generation. That path is server code.

## The publication contract

Six data-plane routes, all keyed by `scopeId` from the path and all authorised as above:

```
PUT  /v1/repo-index/scopes/:scopeId/generations/:attemptId
PUT  /v1/repo-index/scopes/:scopeId/generations/:attemptId/parts/:partNo
POST /v1/repo-index/scopes/:scopeId/generations/:attemptId/finalize
POST /v1/repo-index/scopes/:scopeId/generations/:attemptId/abandon
GET  /v1/repo-index/scopes/:scopeId/receipt
GET  /v1/repo-index/scopes/:scopeId/manifest
```

**Attempt.** Body: `baseGeneration` (integer, 0 or more), `revision` (integer, 1 or more),
`manifestDigest` (1 to 128 characters), `partCount` (1 to 10,000). The attempt id comes from the
path and is unique per scope. The generation number is allocated when the attempt opens
(`max(generation) + 1`, retried once on a unique collision), not when it publishes. Codes:
`201 ATTEMPT_OPEN`, or `200 ATTEMPT_REPLAYED` when the same attempt id is declared again with the
same `baseGeneration`, `revision`, `manifestDigest` and `partCount`. Any difference in that
declaration is `409 ATTEMPT_CONFLICT`, and a generation-number allocation collision that survives
its one retry answers the same.

**Parts.** Body: `upserts` (paths, at most 10,000) and `tombstones` (paths, at most 10,000), both
defaulting to `[]`. `partNo` must be an integer of at least 1 and at most the declared `partCount`,
otherwise `400 PART_OUT_OF_RANGE`. Replay semantics are per part number and per canonical payload
hash (`hashIdempotencyPayload` from `api/idempotency.ts`, sorted keys, sha256):

- `202 PART_ACCEPTED` for a new part.
- `200 PART_REPLAYED` when the same part number arrives with the same payload hash, whatever has
  happened to the attempt since. A stored part is answered from its own row before the attempt's
  status is consulted, so replaying a part after publication is not a refusal.
- `409 PART_CONFLICT` when the same part number arrives with a different payload. The first write
  wins; nothing is overwritten.
- `409 ATTEMPT_FENCED` when the attempt is no longer open and this part number was never stored.
- `409 LOCK_TIMEOUT` when the row lock was not obtained within 5 seconds
  (`LOCK_TIMEOUT_MS`): retry the same call.

Tombstones are stored as paths (`tombstonePaths`), not as a count, and the publication guard
matches them by path.

**Finalize.** Body: `requiredPaths` (paths the caller expects the tree to contain, at most
10,000; an explicit `[]` is allowed), `manifest` (`digest`, `dimensions`, `entries` of at most
10,000, each `{path, digest, vector}` plus optional `lineStart` and `lineEnd`), and the optional
`searchable` flag. A manifest entry has no `chunkId`: the body schema cannot carry one, because a
caller could name a chunk that exists nowhere. Only materialisation writes
`repo_index_paths.chunkId` (see Anchoring, below). Checks run in this order inside one transaction
(`publish` in `store.ts`): scope exists, attempt exists, attempt state, every declared part
present, the promotion fence, declared deletions, the compare-and-swap on the scope row, then the
writes.

`requiredPaths` is a coverage check, not a deletion guard: the fence answers
`422 INVALID_MANIFEST` when a required path is absent from the manifest
(`everyRequirementCovered` in `receipt.ts`). A path the scope still serves that the manifest omits
is refused by the store's `undeclaredDrops` (`store.ts`) unless an accepted part declared it as a
tombstone, and that is the guard deletions rely on. The connector run passes exactly the
manifest's own paths as `requiredPaths` (`requiredPathsOf` in `connector-run.ts`), so it cannot
use that field to declare a deletion.

**The searchable flag.** This route has no content of its own, so it cannot write chunks:

| Value | Answer |
| --- | --- |
| `true` | `422 SEARCHABLE_UNAVAILABLE`, nothing published, the attempt stays open |
| `false` | publishes metadata only, answers `searchable: false, materialisedChunks: 0` |
| absent | same as `false`; an absent flag is not a demand |

The refusal carries a `detail` naming the path that does materialise: the connector run, which
reads every blob at the pinned commit and materialises the generation inside the publish
transaction. The caller is authorised first (`authorize`, `CAPABILITY.FINALIZE`), and the flag is
judged after that, so a caller with no grant on this scope gets `403 GRANT_MISSING` and learns
nothing about what the route would accept.

Every successful finalize answers `searchable: false, materialisedChunks: 0`, because
`store.finalizeAttempt` materialises only when the caller supplies a `readContent` reader and this
route supplies none. A caller that sends a manifest with one valid 1024-wide vector per entry
still gets a metadata-only publication; the vectors are checked by the fence and then not used.

**Success codes.** `201 PUBLISHED` (with `generationId`, `generation`, `receiptDigest`), `200 OK`
for a receipt or manifest read, and the replay codes above.

**Refusal codes an operator can see**, with the HTTP status each maps to. The mapping is a single
table (`HTTP_STATUS` in `repo-index.ts`); a code that table does not hold answers `500`, which is
a programming error, not a refusal.

| Code | HTTP | Meaning | Decided by |
| --- | --- | --- | --- |
| `GRANT_MISSING` | 403 | no token, unknown token, wrong kind, or revoked grant | route |
| `SCOPE_NOT_FOUND` | 404 | no such scope in this org | store |
| `SCOPE_NOT_ACTIVE` | 409 | the admin grant route's answer for any non-active scope; the store keeps it as its fallback for a state it cannot classify | route, store |
| `SCOPE_PAUSED` | 409 | the scope is paused | fence |
| `SCOPE_WITHDRAWN` | 403 | the scope was withdrawn | fence |
| `SCOPE_REVOKED` | 403 | the scope's state is not one the store knows | fence |
| `ATTEMPT_NOT_FOUND` | 404 | no such attempt id in this scope | store |
| `ATTEMPT_CONFLICT` | 409 | the attempt id exists with a different declaration, or a re-finalize presents another manifest | store |
| `ATTEMPT_FENCED` | 409 | the attempt is published, abandoned or failed | store |
| `PART_CONFLICT` | 409 | part number reused with a different payload | store |
| `PART_OUT_OF_RANGE` | 400 | `partNo` below 1 (refused by the route) or above the declared `partCount` (refused by the store) | route, store |
| `PARTS_MISSING` | 409 | some declared parts were never stored; `missingParts` lists them | store |
| `CANNOT_ABANDON_PUBLISHED` | 409 | the attempt is published and cannot be abandoned | store |
| `UNDECLARED_DROP` | 409 | the manifest drops paths the attempt never declared as tombstones; `undeclaredDrops` lists them | store |
| `MISMATCHED_SCOPE` | 409 | the attempt names another scope | fence |
| `MISMATCHED_MANIFEST_DIGEST` | 409 | the attempt's digest differs from the manifest's | fence |
| `SUPERSEDED_BASE` | 409 | `baseGeneration` is older than the active generation | fence |
| `MISMATCHED_BASE` | 409 | `baseGeneration` is newer than the active generation | fence |
| `INVALID_MANIFEST` | 422 | `dimensions` is not 1024, paths repeat, a vector is unusable, or a required path is missing | fence |
| `LOCK_TIMEOUT` | 409 | row-lock contention; retry the same call | store |
| `RECEIPT_NOT_PUBLISHED` | 404 | no published generation for that scope, or none for the named attempt | store |
| `NO_GENERATION_PUBLISHED` | 404 | the scope has never published (`activeGeneration` is 0) | store |
| `GENERATION_EXPIRED` | 410 | the requested generation is no longer the one the scope serves | store |
| `INVALID_CURSOR` | 400 | the cursor was not signed for this scope, or names another generation | store |

The fence evaluates in a fixed order (`promoteAttempt`): scope identity, manifest digest, scope
state, base generation, manifest validity. When several refusals apply, the first in that order is
the one reported.

`CHUNK_LIMIT`, `CONTENT_UNAVAILABLE` and `EMBEDDING_UNAVAILABLE` are not HTTP answers of this
route and carry no status in `HTTP_STATUS`: no `POST .../finalize` response is a 413 or a 503.
They are `materialiseCode` values on a connector run result, reported with `MATERIALISE_REFUSED`
when the publish transaction rolls back, with `layer: "input"` for `CHUNK_LIMIT` and
`EMBEDDING_UNAVAILABLE` and `layer: "connector"` for `CONTENT_UNAVAILABLE`
(`LAYER_FOR_MATERIALISE` in `connector-run.ts`). `POST .../finalize` cannot produce them, because
it supplies no content reader, so its `finalizeAttempt` call materialises nothing. `fence()` in
`store.ts` records a refused attempt as `failed` with the code in `failureCode`, so repeating the
finalize repeats the same code, and an abandon afterwards keeps that code readable.

**Abandon.** `POST .../abandon`, no body. Answers `200 ABANDONED`, `200 ALREADY_ABANDONED`,
`409 CANNOT_ABANDON_PUBLISHED` or `404 ATTEMPT_NOT_FOUND`.

**Receipt and manifest reads.** `GET .../receipt?attemptId=` answers the receipt of that attempt or
of the newest published generation: `scopeId`, `attemptId`, `generation`, `revision`,
`manifestDigest`, `receiptDigest`, `publishedAt`. `GET .../manifest?generation=&cursor=&limit=`
answers one page of path metadata (`path`, `digest`, `lineStart`, `lineEnd`, `chunkId`) ordered by
path, plus `nextCursor`. The store's default page is 100 entries and the route caps `limit` at
500. Only the generation the scope currently serves is readable; any other answers
`410 GENERATION_EXPIRED`. The cursor is base64url JSON (`scopeId`, `generation`, `path`) plus an
HMAC-SHA256 signature, so it cannot be edited or moved to another scope.

## What makes a path searchable

Publication of path rows is not searchability. `repo_index_paths` rows are metadata; nothing in
semantic search reads them. `materialise.ts` is the stage that closes the gap, and it runs on the
same transaction that seals the generation.

- **One synthetic source per scope**, named `repo-index:<scopeId>`, type `repo_index`, created
  under the scope's project with `config.repo_scope_id`. It is visible in the project's source
  list, which is the recorded trade-off: a shared source would make two repositories in one
  project indistinguishable. Nothing is written to `memories`, `sessions` or `messages`, so
  repository text cannot be recalled as conversation memory.
- **One document per path**, keyed by `externalId = path` with `contentHash = digest`, plus
  `path`, `title`, `content` and `metadata.repo_scope_id` / `repo_path` / `repo_digest`.
  `documents` and `chunks` both carry `projectId`, so a result is attributable to the scope's
  project.
- **Chunks with embeddings.** Each path is chunked with the pipeline's own chunker
  (`chunkText` from `engine/chunker.ts`), parent-context chunks are dropped because they carry no
  vector, and the rest are embedded 64 at a time and inserted as ordinary `chunks` rows with a
  `vector(1024)` literal. A vector is accepted only when it is an array of 1024 finite numbers
  with at least one non-zero element (`isUsableVector`); an empty, all-zero or sparse vector is
  `EMBEDDING_UNAVAILABLE`. `searchContent` is the path, heading path, section path and chunk text,
  capped at 20,000 characters, so a keyword search can match the file a hit came from.
- **The chunk cap is 2000 per generation by default**
  (`MATERIALISE_LIMITS.maxChunksPerGeneration`), and
  `RETAINDB_REPO_INDEX_MAX_CHUNKS_PER_GENERATION` raises it for a larger repository (see
  [Configuration](#configuration)). It is checked per file while chunking, so an over-sized tree
  stops before the first embedding request and refuses with `CHUNK_LIMIT` carrying the path.
- **An unchanged digest causes zero re-embeddings.** A path whose previous `documents` row has the
  same digest and at least one chunk is reused: its existing first chunk is named on the new path
  row and nothing is read, chunked or embedded. A path with a changed digest has its chunks
  deleted, its document updated and its content re-embedded. A path the manifest no longer names
  has its document deleted, so recall cannot return a file that is gone.
- **Anchoring.** `repo_index_paths.chunkId` is set to each path's first chunk in one statement per
  generation, which is what connects a search hit back to the published path row.
- **Source counts** (`documentCount`, `chunkCount`, `lastSyncAt`, `status`) are recomputed at the
  end of the materialisation.

Atomicity is the point of doing this inside the publish transaction: a refusal (unreadable
content, an unusable vector, a tree above the ceiling) throws, and the seal, the generation bump
and the path rows roll back together. No generation becomes visible while half its chunks are
missing, and the generation it replaced stays current.

### A cached answer does not outlive the change it describes

Two caches answer a search for one project, and neither key names the generation or the content
revision the answer was computed from: `engine/retriever.ts` keeps a context answer under
`whisper:context:query:<projectId>:<hash(params)>` for 300 seconds, and `engine/memory/search.ts`
keeps a memory answer under `whisper:context:search:<projectId>:<user>:<scope>:<query>` - an empty
memory answer for 60 seconds.

`invalidateProjectAnswers(projectId)` in `store.ts` clears every answer of one project by pattern
(`query:<projectId>:` and `search:<projectId>:`). It runs after each transition that changes what
that project should answer:

- **A committed publication.** `finalizeAttempt` calls it after the transaction returns, never
  inside it: a clear that ran before the commit could be refilled by a concurrent search from the
  tree being replaced, and that answer would then outlive the commit by its full TTL. Adding,
  replacing and dropping a path are one event here, so a dropped path is covered by the same clear.
- **A withdrawal** (`POST /v1/repo-index/admin/scopes/:scopeId/withdraw`). Withdrawal is terminal and
  deletes nothing: the scope's source, its documents, their chunks and its path rows all stay where
  they are, because a delete is the one answer the terminal state could never take back. What
  changes is two things. The project's cached answers are cleared here, so an answer computed while
  the scope was active cannot outlive the state that produced it. And the read path stops returning
  the content: `visibleSourceSql` in `engine/retriever.ts` excludes a chunk whose document belongs to
  a `repo_index` source whose scope `isScopeReadable` refuses (any state but `active`, so paused too),
  inside the scoped set - the rows are filtered before `LIMIT k` takes its `k`, so a hidden row cannot
  occupy a slot a visible one should have answered. So a withdrawn scope is invisible to a search,
  cached or not, while every row it published remains in the database. Pause and resume change that
  state and nothing else: a paused scope is not readable either, and resuming makes it readable again.
  Neither clears the cache the way a withdrawal does, so an answer cached while the scope was active
  can still be served until its 300-second TTL runs out.
- **A grant revocation** (`POST /v1/repo-index/admin/scopes/:scopeId/grants/:grantId/revoke`). The
  tree is untouched - a credential is not content - so the recomputed answer still finds it, but
  the answers cached under the previous grant are gone.

`test/repo-index.search-cache.integration.test.ts` pins each direction through the real publish
transaction and the real admin routes, in one process, against the cache the earlier search filled.
Its withdrawal case asserts the pair that matters: the uncached search answers nothing, and the
`source`, `document`, `chunk` and `repo_index_paths` counts read straight from the tables are the
same before and after the withdrawal. `test/scoped-vector-search.integration.test.ts` pins the reason
the filter is in the SQL and not after the fetch: with the withdrawn scope holding the nearest vector,
a `top_k` of 1 still answers the visible row.

## The connector path

`connector-run.ts` is the only place where the committed-ref reader and the store meet. It takes
an injected provider, an injected-or-real store, and produces one publication or one refusal.

1. **The prior tree comes from the store, never from the request.** Before the ref is read, the
   run pages `readManifest` (1000 paths per page, at most 100 pages). `NO_GENERATION_PUBLISHED`
   is an answer meaning the prior tree is empty. Any other refusal, a throw, a repeated cursor or
   a paging loop answers `PRIOR_TREE_UNKNOWN` and the run stops before pinning anything: an
   unknown prior tree is not an empty one. The request's own `previousPaths` is overwritten with
   this answer, so a caller cannot declare a deletion for a path the scope never published, or
   hide one by leaving the field out.
2. **The ref is pinned to one immutable commit.** `resolveRef` must answer a full lowercase hex
   object id (40 or 64 characters), and every later fetch is addressed by that commit, so a branch
   that moves mid-run cannot mix two revisions. The ref is re-read before and after the blob
   fetches; a moved ref is `STALE_REF`. Tree enumeration refuses a repeated path and a page
   pointer that does not advance as `INCOMPLETE_TREE`, and any entry that is not a regular file
   inside its root (absolute path, parent segment, symlink, submodule, unknown mode, control
   character) as `UNSAFE_TREE` with the violations. Enumeration is also bounded at
   `TREE_PAGES_MAX` pages (100): a provider that still announces another page at that ceiling
   answers `INCOMPLETE_TREE`, because the pages read so far are a prefix and publishing them
   would report every file in the pages left unread as deleted. The git provider gives each git
   call 10 seconds by default (`GIT_TIMEOUT_MS` in `ref-provider-git.ts`); a tree or blob read that
   misses the deadline fails with its own `GIT_TIMEOUT` and refuses the run as `INCOMPLETE_TREE`.
   A timeout is never answered as a file being absent: absence is what the manifest records as a
   deletion, and a deadline is not an answer about the repository. Blobs are read 8 at a time,
   bounded by `maxBlobBytes`; anything short of a complete read is `INCOMPLETE_TREE`.
3. **Deletions are declared, not inferred at publish time.** A path in the prior tree that the new
   manifest does not name is a deletion; the run records it as a tombstone in the first part,
   because a removal is not a manifest entry. Without that, the store would refuse the publication
   as `UNDECLARED_DROP`.
4. **Every path needs a usable embedding before an attempt is opened.** The caller supplies
   `context.vectors`, the fence's per-path vector. A path without one, or with an unusable one,
   answers `MISSING_EMBEDDING` (up to five paths named) and nothing is opened. Chunk vectors are a
   separate concern: they are computed by materialisation with its own embedder
   (`engine/embeddings.ts` by default).
5. **One attempt, bounded parts, one finalize.** Default 500 paths per part. Any refusal or throw
   after the attempt is opened abandons it, so no half-open generation is left behind; whether the
   abandon succeeded is reported as `abandoned`.
6. **`PUBLISHED` means chunks were written.** The run passes a `readContent` reader, so the store
   materialises inside the publish transaction. A materialisation refusal rolls the publication
   back and the run answers `MATERIALISE_REFUSED` with `materialiseCode` naming the cause and
   `layer` naming whose problem it is.

The reader answers from what the manifest scan already fetched: blob content is retained up to
`contentCacheBytes` (default `CONTENT_CACHE_BYTES`, 32 MiB) and released as materialisation
consumes it. Beyond the budget the blob is fetched again at the same pinned commit.

Run codes (`RUN_CODE`), with `layer` and the store code when the store decided:

| Code | Layer | Meaning |
| --- | --- | --- |
| `PUBLISHED` | none | the store published and materialised the attempt |
| `STALE_REF` | connector | the ref no longer points at the pinned commit |
| `INCOMPLETE_TREE` | connector | the provider failed part way; the tree is not full coverage |
| `UNSAFE_TREE` | connector | an entry cannot be read as a regular file inside its root; `violations` lists them |
| `MISSING_EMBEDDING` | input | no usable vector for a manifest path |
| `PRIOR_TREE_UNKNOWN` | store | the store could not say which paths it publishes |
| `STORE_REFUSED` | store | the store answered with a code that forbids this publication |
| `STORE_FAILED` | store | a store call threw |
| `MATERIALISE_REFUSED` | connector or input | the publication rolled back; `materialiseCode` says why |

One `RefProvider` implementation exists: `createGitRefProvider` in
`packages/server/src/connectors/ref-provider-git.ts`. It answers from a repository this process
can already read, with git plumbing and no network: a ref resolves to one full commit id and every
later read is addressed by that id, so a branch that moves mid-run is the connector's `STALE_REF`
rather than a blend of two commits; tree enumeration refuses a non-UTF-8 path or a blob missing
from the object store as `INCOMPLETE_TREE` instead of returning the records that parsed; and a
symlink keeps its git mode, so it is refused as an unsafe entry rather than followed. It is
exercised against real git repositories built in the OS temp directory by
`packages/server/test/repo-index.ref-provider.integration.test.ts`. What does not exist is an
adapter for a hosted forge over HTTP (GitHub, GitLab), or any production caller that wires this
adapter into a route or a run, so the connector has not read a real forge.

## Configuration

| Variable | Required | Behaviour |
| --- | --- | --- |
| `RETAINDB_API_KEY` | to enrol | `authMiddleware` verifies it as `Authorization: Bearer <key>`. Unset means `authType: "open"`, and every admin route then answers `403 ADMIN_REQUIRED`. Read paths keep working without it; enrolment and grant minting do not. |
| `REPO_INDEX_CURSOR_SECRET` | in production | signs and verifies manifest cursors (HMAC-SHA256). |
| `RETAINDB_REPO_INDEX_MAX_CHUNKS_PER_GENERATION` | no | searchable chunks one generation may materialise, checked per publication. Default `2000`; a whole number from 1 to 200000. Any other value refuses the publication when the ceiling is read. |
| `RETAINDB_REPO_STATE_DIR` | no | client-side state directory, default `$HOME/.local/state/retaindb-repo` (`packages/repo-sync/README.md`). |

`RETAINDB_REPO_INDEX_MAX_CHUNKS_PER_GENERATION` is how a repository larger than the default
ceiling gets indexed. Unset or empty it answers `MATERIALISE_LIMITS.maxChunksPerGeneration`, which
is `2000`, so a deployment that never sets it runs the ceiling it always ran. It is read once per
materialisation, when a generation is chunked (`maxChunksPerGeneration()` in `materialise.ts`), and
that call is the only source of the number: `prepareMaterialisation` takes it as its default, so no
second copy decides it. A value that cannot be a ceiling is refused instead of clamped - `0`, `-1`,
`1.5`, `abc`, or anything above `MATERIALISE_LIMITS.largestConfiguredChunks` (`200000`) - and the
refusal names the variable and what it received:

```
RETAINDB_REPO_INDEX_MAX_CHUNKS_PER_GENERATION=1.5 is not a chunk ceiling: set a whole number of chunks between 1 and 200000, or leave it unset for the default of 2000
```

The throw happens inside the publish transaction, so the publication rolls back: the scope keeps the
generation it served, the attempt stays open, and finalizing again with a valid value publishes.
Because the refusal is the process's configuration and not the tree, a committed-ref run reports it
as `STORE_FAILED` carrying that message rather than as `MATERIALISE_REFUSED`.

`EMBEDDING_MODE=gemini` is refused when the process loads. `ingest.ts` keeps gemini in
`MODES_BELOW_STORAGE_WIDTH` (line 21) and calls `refuseUnstorableEmbeddingMode` at module scope
(line 43), because gemini's `text-embedding-004` answers 768 dimensions while `chunks.embedding`
is `vector(1024)` (`EMBEDDING_DIMENSIONS` in `receipt.ts`). The throw is:

```
EMBEDDING_MODE=gemini answers a vector narrower than chunks.embedding vector(1024): migrate the column to the width gemini produces, or configure openai, local, hybrid or remote
```

so a gemini deployment does not start at all: 768 dimensions cannot be stored in the current
column. Using gemini needs `chunks.embedding` migrated to 768 and a re-index, not a looser check.

`REPO_INDEX_CURSOR_SECRET` is read once, as the process loads (`resolveCursorSecret` and the
module-level `CURSOR_SECRET` in `store.ts`). The exact behaviour:

- A non-empty value (trimmed) is used as-is.
- Empty, whitespace-only or unset, with `NODE_ENV === "production"`: the module throws
  `REPO_INDEX_CURSOR_SECRET must be a non-empty secret in production` while loading, so the
  process fails to start rather than signing cursors with a secret an attacker can read.
- Empty, whitespace-only or unset anywhere else: the store falls back to
  `repo-index-local-cursor-secret`, a literal in `store.ts`. That value is published in this
  repository, so any caller can mint a cursor this store accepts. It exists so local runs need no
  setup, and it must never reach a deployment.
- A cursor signed with a different secret fails verification and answers `400 INVALID_CURSOR`, not
  a page. Rotating the secret therefore invalidates cursors already handed out; a client restarts
  the pagination from the first page.

## Operational status

The feature is committed and merged: it landed on `main` at `fa156de`, which contains all six
branches of this line of work, and that commit is pushed to the fork. Its test files
split into two kinds: the database-free ones exercise pure functions or injected fakes, and the
DB-gated ones (`repo-index.admin`, `repo-index.batch`, `repo-index.materialise`, `repo-index.slice`
and the shared `migrations.integration.test.ts`) are written as
`const run = databaseUrl ? test : test.skip;` where `databaseUrl` is
`process.env.RETAINDB_TEST_DATABASE_URL`. Nothing in this worktree sets that variable by default;
the run described below passed it explicitly.

The migration chain was applied to a real PostgreSQL 16 with pgvector 0.8.7 for the first time.
It created 75 tables, including all five `repo_index_*` tables: `repo_index_scopes`,
`repo_index_grants`, `repo_index_generations`, `repo_index_parts` and `repo_index_paths`. With
that database attached, the DB-gated tests execute instead of skipping.

**The suite is green.** The full server suite, run with the database attached, reported 272 tests:
272 pass, 0 fail, 0 skipped. A green run is still not the same as verified end to end, but one
specific gap has now closed: `repo-index.publish.integration.test.ts` drives a real on-disk git
repository through the on-disk provider and `runCommittedRef`, publishes a generation, and then
finds a published path with an actual pgvector nearest-neighbour query that resolves the hit back
to its `repo_index_paths` row, with every stored vector 1024 dimensions and non-zero. Two limits on
that evidence, both deliberate: the vectors come from a deterministic injected embedder rather
than an embedding model, and the query is SQL against the store rather than a request through the
HTTP query route. So a publication has been materialised, read back and found by search at the
storage layer; it has not been found through the deployed query API, and no model produced a vector.

| Part | Runs against a real PostgreSQL | Test that covers it |
| --- | --- | --- |
| Scope enrolment, grant mint, revoke, pause, resume, withdraw | Yes | `packages/server/test/repo-index.admin.integration.test.ts` gates the row-touching cases on `RETAINDB_TEST_DATABASE_URL`; with the database attached those cases execute. Its database-free cases still cover the token hash, the request schemas, route mounting and the state machine against a fake `ScopeStore`. |
| Attempt, parts, finalize, abandon | Yes | `packages/server/test/repo-index.batch.integration.test.ts`, same gate, now executed rather than skipped. |
| Materialisation into sources, documents, chunks | Yes | `packages/server/test/repo-index.materialise.integration.test.ts`, same gate, now executed rather than skipped. |
| Ingest and repository index in one project | Yes | `packages/server/test/repo-index.slice.integration.test.ts`, same gate, now executed rather than skipped. |
| The branch's migration | Yes | `packages/server/test/migrations.integration.test.ts` runs `prisma migrate deploy` against an isolated database when the variable is set; `20261120120500_repo_index_indexing` applied, creating the five `repo_index_*` tables. |
| Reading an indexed path through `/v1/context/query` or search | Yes | `packages/server/test/repo-index.search-cache.integration.test.ts` publishes through the real store and reads the path back with the production `retrieve()` call; `packages/server/test/scoped-vector-search.integration.test.ts` asks the `/v1/context/query` route and requires the visible row to be chosen over a nearer row of a withdrawn scope. Both are gated on `RETAINDB_TEST_DATABASE_URL` and execute with it attached. |
| The connector run against the real store | No | `packages/server/test/repo-index.connector-run.test.ts` still injects a fake `PublicationStore`, so `connector-run.ts` has not run against the real store. The store functions it calls do now execute in the DB-backed suites, and the test's own comment records that `store.ts` cannot be imported by a database-free suite. |
| The committed-ref reader against a real forge | No | `packages/server/test/repo-index.git.integration.test.ts` drives `readCommittedRef` with an in-memory provider and no git subprocess, despite the file name. `packages/server/test/repo-index.ref-provider.integration.test.ts` drives the same reader through `createGitRefProvider` (`packages/server/src/connectors/ref-provider-git.ts`) against real git repositories it builds in the OS temp directory and removes afterwards, so the git plumbing is exercised: a pinned commit, a branch that moved, a truncated listing, a missing blob, a symlink mode. No adapter speaks to GitHub or GitLab, so no run has read a real forge. |
| The Rust client transmitting a batch | No | `packages/repo-sync/src/transport.rs` holds `transport::deliver` and `CurlTransport`: one bounded request per generation, the grant read from `RETAINDB_REPO_INDEX_GRANT`, 413 refused locally before sending, and the watermark advanced only by a parsed receipt. Twelve contract tests in `packages/repo-sync/tests/transport.rs` drive `deliver` through a fake `Transport`, so no test opens a socket or runs `curl`; the package's 122 tests pass with `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and `cargo build --offline` clean and still zero dependencies. What is unproven is the seam: no CLI subcommand calls `deliver`, the batch body (`enrollment_id`, `generation`, `part_no`, `changes`) is the transport's own wire contract and no Server route reads it, and no batch has been sent to a live RetainDB. |

So: the enrolment surface, the fence, the cursor signing, the chunk partitioning and the run's
decision logic are covered by tests that do not need a database. Tests that need rows now execute
against a real PostgreSQL, and the full suite is green: 272 of 272 pass. Treat the feature as
unreleased and not verified end to end: a publication has now been materialised and found by a
pgvector query over its stored vectors, but with an injected deterministic embedder and against the
store rather than through the HTTP query route, so the deployed search path remains unproven. The
transport exists but no batch has reached a live RetainDB, the committed-ref adapter has run only
against on-disk fixture repositories, no real client (Claude, Codex or Hermes) has been exercised
against this feature, and nothing is deployed.
