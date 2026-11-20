import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { EMBEDDING_DIMENSIONS, PROMOTION_OUTCOME, promoteAttempt, scopeRefusal } from "../src/engine/repo-index/receipt.js";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const savedEnvironment = { ...process.env };
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
}

const storePath = "../src/engine/repo-index/store.js";
const apiPath = "../src/api/repo-index.js";
const idempotencyPath = "../src/api/idempotency.js";
const receiptPath = "../src/engine/repo-index/receipt.js";

/**
 * Cursor signing secret for this process. The store reads REPO_INDEX_CURSOR_SECRET and falls
 * back to a documented local value; setting it here lets the cursor tests mint their own and
 * keeps the secret an environment contract rather than a value baked into the store.
 */
const CURSOR_SECRET = "repo-index-test-cursor-secret";
process.env.REPO_INDEX_CURSOR_SECRET = CURSOR_SECRET;
/**
 * The store builds a Prisma client as it loads, so it needs a well-formed URL even for checks
 * that answer before the first query. Nothing below reaches this address.
 */
if (!databaseUrl) process.env.DATABASE_URL = "postgresql://cursor-test:unused@127.0.0.1:1/unreachable";

/** Width of the vectors a manifest declares; receipt.ts refuses any width but this one. */
const DIMENSIONS = EMBEDDING_DIMENSIONS;
/** Header that carries the scope grant token; the scope itself comes from the path. */
const GRANT_HEADER = "X-RetainDB-Repo-Index-Grant";
const scopeIds: string[] = [];

function scopeData() {
  const id = randomUUID();
  return {
    projectId: `project-${id}`,
    repoHost: "github.com",
    repoExternalId: `repo-${id}`,
    worktreePath: `/worktrees/${id}`,
    deviceId: `device-${id}`,
    ref: "refs/heads/main",
    headCommit: "commit-0f0f",
    policyVersion: "policy-1",
    pipelineVersion: "pipeline-1",
  };
}

async function fixture() {
  const { db } = await import("../src/db/index.js");
  // The generated client in a checked-out worktree can predate the repo-index models.
  const client = db as any;
  const scope = await client.repoIndexScope.create({ data: scopeData() });
  scopeIds.push(scope.id);
  return { db: client, scope };
}

function attemptFor(scopeId: string, attemptId: string, extra: Record<string, unknown> = {}) {
  return {
    scopeId,
    attemptId,
    baseGeneration: 0,
    revision: 1,
    manifestDigest: "digest-1",
    partCount: 1,
    ...extra,
  };
}

function vector(): number[] {
  const values = Array<number>(DIMENSIONS).fill(0);
  values[0] = 1;
  return values;
}

function entry(path: string, digest = `content-${path}`) {
  return { path, digest, vector: vector() };
}

function manifestFor(digest: string, entries: Array<ReturnType<typeof entry>>) {
  return { digest, dimensions: DIMENSIONS, entries };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Behaviour: the manifest every database test below builds is one the real publication fence
// accepts. receipt.ts pins the width chunks.embedding accepts, so a suite that declared another
// width would fail here while every database test refused the manifest as INVALID_MANIFEST.
test("the manifest the batch suite builds passes the publication fence", () => {
  const promotion = promoteAttempt({
    active: { scopeId: "scope-1", generation: 0, revision: 0, manifestDigest: null, status: "active" },
    attempt: { scopeId: "scope-1", attemptId: "attempt-1", baseGeneration: 0, revision: 1, manifestDigest: "digest-1" },
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
    requiredPaths: ["src/a.ts"],
  });

  assert.equal(promotion.outcome, PROMOTION_OUTCOME.PROMOTED);
  assert.equal(promotion.active.generation, 1);
});

// Behaviour: a manifest at any other width is refused, so the width this suite builds is not a
// free choice: only EMBEDDING_DIMENSIONS can be stored in chunks.embedding and searched.
test("a manifest at another width is refused as invalid", () => {
  const narrow = Array<number>(8).fill(0);
  narrow[0] = 1;

  const promotion = promoteAttempt({
    active: { scopeId: "scope-1", generation: 0, revision: 0, manifestDigest: null, status: "active" },
    attempt: { scopeId: "scope-1", attemptId: "attempt-1", baseGeneration: 0, revision: 1, manifestDigest: "digest-1" },
    manifest: { digest: "digest-1", dimensions: 8, entries: [{ path: "src/a.ts", vector: narrow }] },
    requiredPaths: [],
  });

  assert.equal(promotion.outcome, PROMOTION_OUTCOME.INVALID_MANIFEST);
  assert.equal(EMBEDDING_DIMENSIONS, 1024);
});

// Behaviour: the drop guard decides by path, not by count. Two tombstones for paths that never
// exist cannot pay for erasing two real paths, which is how an empty manifest with two ghost
// tombstones once replaced the last good tree with nothing.
test("the drop guard matches declared tombstone paths, not their count", async () => {
  const store = await import(storePath);
  const ghostTombstones = new Set(["ghost-1", "ghost-2"]);

  assert.deepEqual(
    store.undeclaredDroppedPaths(["src/a.ts", "src/b.ts"], [], ghostTombstones),
    ["src/a.ts", "src/b.ts"],
    "two ghost tombstones do not cover two real drops",
  );
  assert.deepEqual(
    store.undeclaredDroppedPaths(["src/a.ts", "src/b.ts"], ["src/a.ts"], new Set(["src/b.ts"])),
    [],
    "a declared drop of the path the manifest omits is allowed",
  );
  assert.deepEqual(
    store.undeclaredDroppedPaths(["src/a.ts", "src/b.ts"], ["src/a.ts"], new Set()),
    ["src/b.ts"],
    "an undeclared drop is named by path",
  );
  assert.deepEqual(
    store.undeclaredDroppedPaths(["src/a.ts"], ["src/a.ts"], new Set()),
    [],
    "keeping every present path declares no deletion",
  );
});

// Behaviour: a production process refuses to sign or verify manifest cursors without a secret.
// The fallback is published in the source, so using it in production would let any caller mint a
// cursor this store accepts; an empty value is not a secret either.
test("a production process without a cursor secret refuses to load", async () => {
  const store = await import(storePath);

  assert.throws(() => store.resolveCursorSecret({ NODE_ENV: "production" }), /REPO_INDEX_CURSOR_SECRET/);
  assert.throws(
    () => store.resolveCursorSecret({ NODE_ENV: "production", REPO_INDEX_CURSOR_SECRET: "" }),
    /REPO_INDEX_CURSOR_SECRET/,
    "an empty secret is unset, not a configured value",
  );
  assert.throws(
    () => store.resolveCursorSecret({ NODE_ENV: "production", REPO_INDEX_CURSOR_SECRET: "   " }),
    /REPO_INDEX_CURSOR_SECRET/,
    "a blank secret is unset too",
  );
  assert.equal(store.resolveCursorSecret({ NODE_ENV: "production", REPO_INDEX_CURSOR_SECRET: "s3cret" }), "s3cret");
  assert.equal(store.resolveCursorSecret({ REPO_INDEX_CURSOR_SECRET: "" }), "repo-index-local-cursor-secret");
  assert.equal(store.resolveCursorSecret({}), "repo-index-local-cursor-secret");
});

// Behaviour: paused, withdrawn and revoked are three different answers. A paused scope is not
// revoked and a revoked one is not withdrawn, in the fence, the store or the API.
test("each scope state keeps its own refusal code", () => {
  assert.equal(scopeRefusal("paused"), PROMOTION_OUTCOME.SCOPE_PAUSED);
  assert.equal(scopeRefusal("withdrawn"), PROMOTION_OUTCOME.SCOPE_WITHDRAWN);
  assert.equal(scopeRefusal("revoked"), PROMOTION_OUTCOME.SCOPE_REVOKED);
  assert.equal(scopeRefusal("active"), undefined);

  const promotion = promoteAttempt({
    active: { scopeId: "scope-1", generation: 0, revision: 0, manifestDigest: null, status: "paused" },
    attempt: { scopeId: "scope-1", attemptId: "attempt-1", baseGeneration: 0, revision: 1, manifestDigest: "digest-1" },
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
    requiredPaths: ["src/a.ts"],
  });
  assert.equal(promotion.outcome, PROMOTION_OUTCOME.SCOPE_PAUSED);
});

// Behaviour: a lock wait that expires under contention is a retryable refusal, not a 500. Both
// shapes a row-lock wait produces are recognised, and any other failure keeps propagating.
test("an expired lock wait is recognised as retryable contention", async () => {
  const store = await import(storePath);

  assert.equal(store.isLockTimeout({ code: "P2010", meta: { code: "55P03" } }), true, "lock_timeout");
  assert.equal(store.isLockTimeout({ code: "P2028" }), true, "transaction expired while queued");
  assert.equal(store.isLockTimeout({ code: "P2025" }), false);
  assert.equal(store.isLockTimeout({ code: "P2010", meta: { code: "23505" } }), false);
  assert.equal(store.isLockTimeout(new Error("boom")), false);
});

function grantRequest(method: string, url: string, token: string | undefined, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      ...(token ? { [GRANT_HEADER]: token } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The unsigned body of a cursor: what a caller could write by itself without the secret. */
function cursorBody(position: { scopeId: string; generation: number; path: string }): string {
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/** A cursor as this store issues it, so the test can present one minted for another scope. */
function cursorFor(scopeId: string, generation: number, path: string): string {
  const body = cursorBody({ scopeId, generation, path });
  return `${body}.${createHmac("sha256", CURSOR_SECRET).update(body, "utf8").digest("base64url")}`;
}

/**
 * How many connections are queued for a row lock on the scopes table. A finalize's
 * compare-and-swap waits there, so counting waiters is how a test knows both writers have read
 * the same base generation and neither has written yet.
 */
async function blockedScopeWriters(db: any, holderTransactionId: string, expected: number): Promise<boolean> {
  // A row-lock waiter is not recorded against the relation it waits on. The first writer in the
  // queue waits on the locking transaction's id (pg_locks.transactionid), and only the writers
  // queued behind it carry a tuple lock on `repo_index_scopes`. Both shapes are a writer that
  // reached its scope compare-and-swap and is waiting for the holder to commit, so both count.
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = (await db.$queryRaw`
      SELECT count(DISTINCT pid)::int AS waiting
      FROM pg_locks
      WHERE NOT granted
        AND (relation = 'repo_index_scopes'::regclass OR transactionid::text = ${holderTransactionId})
    `) as Array<{ waiting: number }>;
    if ((rows[0]?.waiting ?? 0) >= expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * Holds one scope row's write lock from a second connection while `body` runs. Every writer that
 * compares-and-swaps the scope queues behind it, so the body can start the writers, watch them
 * queue, and only then let them continue: that is the interleaving, not a claim about ordering.
 * The body gets the holding transaction and the transaction id the row lock belongs to, so it can
 * change the scope inside the same lock and count the writers queueing on it.
 */
async function whileScopeRowLocked(
  db: any,
  scopeId: string,
  body: (holder: any, holderTransactionId: string) => Promise<void>,
): Promise<void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let holderTransaction: any;
  let holderTransactionId!: string;
  const holder = db.$transaction(
    async (tx: any) => {
      holderTransaction = tx;
      await tx.$queryRaw`SELECT "id" FROM "repo_index_scopes" WHERE "id" = ${scopeId} FOR UPDATE`;
      const [row] = (await tx.$queryRaw`SELECT txid_current()::text AS xid`) as Array<{ xid: string }>;
      holderTransactionId = row.xid;
      locked();
      await released;
    },
    { timeout: 30_000 },
  );
  await Promise.race([acquired, holder]);
  try {
    await body(holderTransaction, holderTransactionId);
  } finally {
    release();
    await holder;
  }
}

/** Creates one grant per capability named, with the token the test will present. */
async function grantsFor(db: any, scopeId: string, tokens: Record<string, string>): Promise<void> {
  await db.repoIndexGrant.createMany({
    data: Object.entries(tokens).map(([kind, token]) => ({ scopeId, kind, principal: kind, tokenHash: sha256(token) })),
  });
}

// Behaviour: a cursor is honoured only when this store signed it for this scope. A caller that
// writes its own payload, edits the payload after signing, or presents a cursor minted for
// another scope is refused as an invalid cursor before any row is read.
test("a cursor this store did not sign for this scope is refused as invalid", async () => {
  const store = await import(storePath);
  const unsigned = cursorBody({ scopeId: "scope-1", generation: 1, path: "src/a.ts" });

  const cursors: Record<string, string> = {
    garbage: "not-a-cursor",
    unsigned,
    tampered: `${unsigned}.${"A".repeat(43)}`,
    foreignScope: cursorFor("scope-2", 1, "src/a.ts"),
  };
  for (const [name, cursor] of Object.entries(cursors)) {
    const page = await store.readManifest({ scopeId: "scope-1", cursor });
    assert.equal(page.code, store.STORE_CODE.INVALID_CURSOR, `${name} cursor`);
  }
});

// Behaviour: two writers that opened against the same base generation cannot both publish; the
// compare-and-swap lets exactly one through and the loser is refused. The scope row is locked from
// a second connection, so both writers really reach their compare-and-swap and queue on it before
// either writes: the test forces the interleaving instead of hoping two promises overlap.
run("concurrent claims on the same base cannot both publish", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  const manifest = manifestFor("digest-a", [entry("src/a.ts")]);

  for (const attemptId of ["attempt-a", "attempt-b"]) {
    const opened = await store.openAttempt(attemptFor(scope.id, attemptId, { manifestDigest: "digest-a" }));
    assert.equal(opened.code, store.STORE_CODE.ATTEMPT_OPEN);
    await store.putPart({ scopeId: scope.id, attemptId, partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  }

  const finalize = (attemptId: string) =>
    store.finalizeAttempt({ ...attemptFor(scope.id, attemptId, { manifestDigest: "digest-a" }), requiredPaths: ["src/a.ts"], manifest });
  const racing: Array<Promise<any>> = [];
  await whileScopeRowLocked(db, scope.id, async (_holder, holderTransactionId) => {
    racing.push(finalize("attempt-a"), finalize("attempt-b"));
    assert.ok(await blockedScopeWriters(db, holderTransactionId, 2), "both finalizes reached the scope compare-and-swap");
  });
  const [left, right] = await Promise.all(racing);

  const { PROMOTION_OUTCOME } = await import(receiptPath);
  assert.deepEqual(
    [left.code, right.code].sort(),
    [store.STORE_CODE.PUBLISHED, PROMOTION_OUTCOME.SUPERSEDED_BASE].sort(),
  );

  // The winner's own generation is what the scope claims, whatever order the two writers committed
  // in: attempt-a and attempt-b race from base 0, so the scope names generation 1 or 2.
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  const published = await db.repoIndexGeneration.findMany({ where: { scopeId: scope.id, status: "published" } });
  assert.equal(published.length, 1);
  assert.equal(storedScope.activeGeneration, published[0].generation);
  const paths = await db.repoIndexPath.findMany({ where: { scopeId: scope.id } });
  assert.equal(paths.length, 1);
  assert.equal(paths[0].generationId, published[0].id);
});

// Behaviour: a part replayed with the same payload answers with the outcome already
// stored for that part number instead of accepting a second row.
run("a replayed part with the same payload returns the stored outcome", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  const opened = await store.openAttempt(attemptFor(scope.id, "attempt-1", { partCount: 2 }));
  assert.equal(opened.code, store.STORE_CODE.ATTEMPT_OPEN);

  const part = { upserts: ["src/a.ts", "src/b.ts"], tombstones: ["src/old.ts"] };
  const accepted = await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part });
  const replayed = await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part });

  assert.equal(accepted.code, store.STORE_CODE.PART_ACCEPTED);
  assert.equal(replayed.code, store.STORE_CODE.PART_REPLAYED);
  assert.equal(replayed.upsertCount, accepted.upsertCount);
  assert.equal(replayed.tombstoneCount, accepted.tombstoneCount);
  assert.equal(replayed.status, accepted.status);
  const parts = await db.repoIndexPart.findMany({ where: { generationId: opened.generationId } });
  assert.equal(parts.length, 1);
});

// Behaviour: the same part number with a changed payload is a conflict, and the
// stored outcome keeps describing the payload that was actually accepted.
run("a changed payload for the same part number is refused and does not overwrite", { timeout: 30_000 }, async () => {
  const { hashIdempotencyPayload } = await import(idempotencyPath);
  const store = await import(storePath);
  const { db, scope } = await fixture();
  const opened = await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  assert.equal(opened.code, store.STORE_CODE.ATTEMPT_OPEN);

  const accepted = await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-1",
    partNo: 1,
    part: { upserts: ["src/a.ts"], tombstones: [] },
  });
  const changed = await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-1",
    partNo: 1,
    part: { upserts: ["src/b.ts"], tombstones: [] },
  });

  assert.equal(accepted.code, store.STORE_CODE.PART_ACCEPTED);
  assert.equal(changed.code, store.STORE_CODE.PART_CONFLICT);
  const stored = await db.repoIndexPart.findFirstOrThrow({
    where: { generationId: opened.generationId, partNo: 1 },
  });
  assert.equal(stored.requestHash, hashIdempotencyPayload({ upserts: ["src/a.ts"], tombstones: [] }));
  assert.equal(stored.upsertCount, 1);
  assert.equal(stored.tombstoneCount, 0);
});

// Behaviour: parts may arrive out of order, and the attempt finalizes only once every
// declared part number is present; before that nothing is published.
run("out-of-order parts finalize only when every declared part is present", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  const opened = await store.openAttempt(attemptFor(scope.id, "attempt-1", { partCount: 2 }));
  assert.equal(opened.code, store.STORE_CODE.ATTEMPT_OPEN);

  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 2, part: { upserts: ["src/b.ts"], tombstones: [] } });
  const early = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { partCount: 2 }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });
  assert.equal(early.code, store.STORE_CODE.PARTS_MISSING);
  const unpublished = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(unpublished.activeGeneration, 0);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id } }), 0);

  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const sealed = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { partCount: 2 }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });
  assert.equal(sealed.code, store.STORE_CODE.PUBLISHED);
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, 1);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id, state: "present" } }), 2);
});

// Behaviour: completeness is per declared part number, not a count of stored rows. Parts 1 and 3
// of a three-part attempt are two rows, and the attempt still reports the gap at part 2.
run("a three-part attempt is incomplete without the part in the middle", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  const opened = await store.openAttempt(attemptFor(scope.id, "attempt-1", { partCount: 3 }));
  assert.equal(opened.code, store.STORE_CODE.ATTEMPT_OPEN);
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 3, part: { upserts: ["src/c.ts"], tombstones: [] } });

  const early = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { partCount: 3 }),
    requiredPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts"), entry("src/c.ts")]),
  });

  assert.equal(early.code, store.STORE_CODE.PARTS_MISSING);
  assert.deepEqual(early.missingParts, [2]);
  const unpublished = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(unpublished.activeGeneration, 0);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id } }), 0);

  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 2, part: { upserts: ["src/b.ts"], tombstones: [] } });
  const sealed = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { partCount: 3 }),
    requiredPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts"), entry("src/c.ts")]),
  });
  assert.equal(sealed.code, store.STORE_CODE.PUBLISHED);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id, state: "present" } }), 3);
});

// Behaviour: a manifest larger than one write batch is published whole. 501 entries make the
// 500-row loop iterate twice, and the second page still serves the entry the second batch wrote,
// so a batching bug that dropped the tail would show up here.
run("a 501-entry manifest is written across two batches", { timeout: 60_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  const entries = Array.from({ length: 501 }, (_unused, index) => entry(`src/file-${String(index).padStart(3, "0")}.ts`));
  await store.openAttempt(attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }));
  await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-1",
    partNo: 1,
    part: { upserts: entries.map((item) => item.path), tombstones: [] },
  });

  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }),
    requiredPaths: [],
    manifest: manifestFor("digest-1", entries),
  });

  assert.equal(published.code, store.STORE_CODE.PUBLISHED);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id, state: "present" } }), 501);
  const first = await store.readManifest({ scopeId: scope.id, limit: 500 });
  assert.equal(first.entries.length, 500);
  assert.ok(first.nextCursor);
  const second = await store.readManifest({ scopeId: scope.id, cursor: first.nextCursor, limit: 500 });
  assert.deepEqual(second.entries.map((item: any) => item.path), ["src/file-500.ts"]);
  assert.equal(second.nextCursor, null);
});

// Behaviour: a published attempt is sealed, so abandoning it is refused and the
// published generation keeps its receipt.
run("abandoning a published attempt is refused", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  const opened = await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1"),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  const refused = await store.abandonAttempt({ scopeId: scope.id, attemptId: "attempt-1" });

  assert.equal(refused.code, store.STORE_CODE.CANNOT_ABANDON_PUBLISHED);
  const generation = await db.repoIndexGeneration.findUniqueOrThrow({ where: { id: opened.generationId } });
  assert.equal(generation.status, "published");
  assert.equal(generation.receiptDigest, published.receiptDigest);
  assert.notEqual(generation.publishedAt, null);
});

// Behaviour: an abandon and a publication that race cannot both succeed. The finalize is held at
// its compare-and-swap, so the abandon starts while the publication decision is already made; the
// attempt row decides which of the two wins, and the loser is told why.
run("an abandon and a publication that race cannot both succeed", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });

  const racing: Array<Promise<any>> = [];
  await whileScopeRowLocked(db, scope.id, async (_holder, holderTransactionId) => {
    racing.push(
      store.finalizeAttempt({
        ...attemptFor(scope.id, "attempt-1"),
        requiredPaths: ["src/a.ts"],
        manifest: manifestFor("digest-1", [entry("src/a.ts")]),
      }),
    );
    assert.ok(await blockedScopeWriters(db, holderTransactionId, 1), "the finalize reached the scope compare-and-swap");
    racing.push(store.abandonAttempt({ scopeId: scope.id, attemptId: "attempt-1" }));
  });
  const [published, abandoned] = await Promise.all(racing);

  assert.deepEqual(
    [published.code, abandoned.code].sort(),
    [store.STORE_CODE.PUBLISHED, store.STORE_CODE.CANNOT_ABANDON_PUBLISHED].sort(),
  );
  const generation = await db.repoIndexGeneration.findUniqueOrThrow({
    where: { scopeId_attemptId: { scopeId: scope.id, attemptId: "attempt-1" } },
  });
  assert.equal(generation.status, "published");
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, 1);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id, state: "present" } }), 1);
});

// Behaviour: the compare-and-swap repeats the scope's state, not only its generation. The
// withdrawal commits on the same row while the publication is already queued on it, so the fence
// read `active` but the write must not match; without `state: "active"` in the predicate the
// update would succeed and publish a withdrawn scope.
run("a withdrawal committed ahead of the compare-and-swap stops the publication", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { PROMOTION_OUTCOME } = await import(receiptPath);
  const { db, scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });

  const racing: Array<Promise<any>> = [];
  await whileScopeRowLocked(db, scope.id, async (holder, holderTransactionId) => {
    racing.push(
      store.finalizeAttempt({
        ...attemptFor(scope.id, "attempt-1"),
        requiredPaths: ["src/a.ts"],
        manifest: manifestFor("digest-1", [entry("src/a.ts")]),
      }),
    );
    assert.ok(await blockedScopeWriters(db, holderTransactionId, 1), "the finalize reached the scope compare-and-swap");
    // Same transaction, same row lock: the withdrawal commits before the queued writer can claim.
    await holder.repoIndexScope.update({ where: { id: scope.id }, data: { state: "withdrawn" } });
  });
  const [refused] = await Promise.all(racing);

  assert.equal(refused.code, PROMOTION_OUTCOME.SCOPE_WITHDRAWN);
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, 0);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id } }), 0);
  const generation = await db.repoIndexGeneration.findUniqueOrThrow({
    where: { scopeId_attemptId: { scopeId: scope.id, attemptId: "attempt-1" } },
  });
  assert.equal(generation.status, "failed");
  assert.equal(generation.failureCode, PROMOTION_OUTCOME.SCOPE_WITHDRAWN);
});

// Behaviour: a part that was accepted before the publication replays from its own row after it, so
// a client retrying an upload it already stored learns the stored outcome instead of a refusal.
run("a stored part replays after the attempt is published", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1", { partCount: 2 }));
  const part = { upserts: ["src/a.ts"], tombstones: [] };
  const accepted = await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part });
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 2, part: { upserts: ["src/b.ts"], tombstones: [] } });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { partCount: 2 }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  const replayed = await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part });
  const changed = await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/c.ts"], tombstones: [] } });
  const beyond = await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 3, part: { upserts: ["src/c.ts"], tombstones: [] } });

  assert.equal(accepted.code, store.STORE_CODE.PART_ACCEPTED);
  assert.equal(replayed.code, store.STORE_CODE.PART_REPLAYED);
  assert.equal(replayed.upsertCount, accepted.upsertCount);
  assert.equal(changed.code, store.STORE_CODE.PART_CONFLICT);
  assert.equal(beyond.code, store.STORE_CODE.PART_OUT_OF_RANGE);
  assert.equal(await db.repoIndexPart.count({ where: { generationId: published.generationId } }), 2);
});

// Behaviour: an attempt whose base generation is no longer active is refused, and the
// generation readers currently see keeps both its label and its paths.
run("a superseded attempt leaves the previous generation and its paths published", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { PROMOTION_OUTCOME } = await import(receiptPath);
  const { db, scope } = await fixture();

  const first = await store.openAttempt(attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts", "src/b.ts"], tombstones: [] } });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  // A late writer still declares the generation it read before the publish.
  const stale = await store.openAttempt(attemptFor(scope.id, "attempt-2", { manifestDigest: "digest-2" }));
  assert.equal(stale.code, store.STORE_CODE.ATTEMPT_OPEN);
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-2", partNo: 1, part: { upserts: ["src/c.ts"], tombstones: [] } });
  const refused = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-2", { manifestDigest: "digest-2" }),
    requiredPaths: ["src/c.ts"],
    manifest: manifestFor("digest-2", [entry("src/c.ts")]),
  });

  assert.equal(refused.code, PROMOTION_OUTCOME.SUPERSEDED_BASE);
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, 1);
  const paths = await db.repoIndexPath.findMany({ where: { scopeId: scope.id }, orderBy: { path: "asc" } });
  assert.deepEqual(paths.map((path: any) => path.path), ["src/a.ts", "src/b.ts"]);
  assert.ok(paths.every((path: any) => path.generationId === first.generationId));
  assert.ok(paths.every((path: any) => path.state === "present"));
});

// Behaviour: a withdrawal of the scope stops the publication and is named as a withdrawal, so the
// caller does not chase a base generation that never moved.
run("a withdrawn scope refuses the publication", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { PROMOTION_OUTCOME } = await import(receiptPath);
  const { db, scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  await db.repoIndexScope.update({ where: { id: scope.id }, data: { state: "withdrawn" } });

  const refused = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1"),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
  });

  assert.equal(refused.code, PROMOTION_OUTCOME.SCOPE_WITHDRAWN);
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, 0);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id } }), 0);
  const generation = await db.repoIndexGeneration.findUniqueOrThrow({
    where: { scopeId_attemptId: { scopeId: scope.id, attemptId: "attempt-1" } },
  });
  assert.equal(generation.status, "failed");
  assert.equal(generation.failureCode, PROMOTION_OUTCOME.SCOPE_WITHDRAWN);
  assert.equal(generation.receiptDigest, null);
});

// Behaviour: paths a later manifest no longer names are tombstoned in the new generation, so a
// deleted file stops being served as present. The deletion has to be declared in the attempt's
// parts, which is what makes it a deletion rather than a truncated manifest.
run("a path the new manifest omits becomes a tombstone of the new generation", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();

  const first = await store.openAttempt(attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts", "src/b.ts"], tombstones: [] } });
  await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });

  const second = await store.openAttempt(
    attemptFor(scope.id, "attempt-2", { baseGeneration: 1, revision: 2, manifestDigest: "digest-2" }),
  );
  assert.equal(second.code, store.STORE_CODE.ATTEMPT_OPEN);
  await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-2",
    partNo: 1,
    part: { upserts: ["src/a.ts"], tombstones: ["src/b.ts"] },
  });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-2", { baseGeneration: 1, revision: "rev-2", manifestDigest: "digest-2" }),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-2", [entry("src/a.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  const kept = await db.repoIndexPath.findFirstOrThrow({ where: { scopeId: scope.id, path: "src/a.ts" } });
  const dropped = await db.repoIndexPath.findFirstOrThrow({ where: { scopeId: scope.id, path: "src/b.ts" } });
  assert.equal(kept.state, "present");
  assert.equal(kept.generationId, second.generationId);
  assert.notEqual(second.generationId, first.generationId);
  assert.equal(dropped.state, "tombstone");
  assert.equal(dropped.generationId, second.generationId);
});

// Behaviour: a manifest may not shrink the tree on its own. A caller that drops a path without
// declaring it as a tombstone is refused, so a truncated or empty manifest cannot replace the
// last good tree with nothing; declaring the same path lets the publication through.
run("a manifest that drops a path the attempt did not tombstone is refused", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts", "src/b.ts"], tombstones: [] } });
  await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });

  await store.openAttempt(attemptFor(scope.id, "attempt-2", { baseGeneration: 1, revision: 2, manifestDigest: "digest-2" }));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-2", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const refused = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-2", { baseGeneration: 1, revision: 2, manifestDigest: "digest-2" }),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-2", [entry("src/a.ts")]),
  });

  assert.equal(refused.code, store.STORE_CODE.UNDECLARED_DROP);
  assert.deepEqual(refused.undeclaredDrops, ["src/b.ts"]);
  const unchanged = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(unchanged.activeGeneration, 1);
  const stillPresent = await db.repoIndexPath.findMany({ where: { scopeId: scope.id }, orderBy: { path: "asc" } });
  assert.deepEqual(stillPresent.map((row: any) => [row.path, row.state]), [["src/a.ts", "present"], ["src/b.ts", "present"]]);

  await store.openAttempt(attemptFor(scope.id, "attempt-3", { baseGeneration: 1, revision: 3, manifestDigest: "digest-3" }));
  await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-3",
    partNo: 1,
    part: { upserts: ["src/a.ts"], tombstones: ["src/b.ts"] },
  });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-3", { baseGeneration: 1, revision: 3, manifestDigest: "digest-3" }),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-3", [entry("src/a.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);
  const dropped = await db.repoIndexPath.findFirstOrThrow({ where: { scopeId: scope.id, path: "src/b.ts" } });
  assert.equal(dropped.state, "tombstone");
});

// Behaviour: a tombstone for a path that never existed cannot pay for erasing a real one. The
// attempt declares two ghost tombstones and publishes an empty manifest; a count-based guard saw
// two drops against two declarations, bumped the generation and tombstoned both real paths. The
// publication must be refused, and it must name the paths it would have erased.
run("a tombstone for a path that never existed cannot erase a real path", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }));
  await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-1",
    partNo: 1,
    part: { upserts: ["src/a.ts", "src/b.ts"], tombstones: [] },
  });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  const ghost = await store.openAttempt(
    attemptFor(scope.id, "attempt-2", { baseGeneration: published.generation, revision: 2, manifestDigest: "digest-2" }),
  );
  assert.equal(ghost.code, store.STORE_CODE.ATTEMPT_OPEN);
  const accepted = await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-2",
    partNo: 1,
    part: { upserts: [], tombstones: ["ghost-1", "ghost-2"] },
  });
  assert.equal(accepted.code, store.STORE_CODE.PART_ACCEPTED);
  // The paths are what the guard compares, so the part row has to carry them and not only a count.
  const storedPart = await db.repoIndexPart.findFirstOrThrow({ where: { generationId: ghost.generationId, partNo: 1 } });
  assert.deepEqual(storedPart.tombstonePaths, ["ghost-1", "ghost-2"]);
  assert.equal(storedPart.tombstoneCount, 2);

  const refused = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-2", {
      baseGeneration: published.generation,
      revision: 2,
      manifestDigest: "digest-2",
    }),
    requiredPaths: [],
    manifest: manifestFor("digest-2", []),
  });

  assert.equal(refused.code, store.STORE_CODE.UNDECLARED_DROP);
  assert.deepEqual(refused.undeclaredDrops, ["src/a.ts", "src/b.ts"]);
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, published.generation);
  const paths = await db.repoIndexPath.findMany({ where: { scopeId: scope.id }, orderBy: { path: "asc" } });
  assert.deepEqual(
    paths.map((row: any) => [row.path, row.state]),
    [
      ["src/a.ts", "present"],
      ["src/b.ts", "present"],
    ],
  );
});

// Behaviour: abandoning an open attempt fences it once, and a fenced attempt refuses
// further parts and refuses to publish.
run("an abandoned attempt is fenced once and stays fenced", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  const opened = await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  assert.equal(opened.code, store.STORE_CODE.ATTEMPT_OPEN);

  const abandoned = await store.abandonAttempt({ scopeId: scope.id, attemptId: "attempt-1" });
  const again = await store.abandonAttempt({ scopeId: scope.id, attemptId: "attempt-1" });
  const part = await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const publish = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1"),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
  });

  assert.equal(abandoned.code, store.STORE_CODE.ABANDONED);
  assert.equal(again.code, store.STORE_CODE.ALREADY_ABANDONED);
  assert.equal(part.code, store.STORE_CODE.ATTEMPT_FENCED);
  assert.equal(publish.code, store.STORE_CODE.ATTEMPT_FENCED);
  const generation = await db.repoIndexGeneration.findUniqueOrThrow({ where: { id: opened.generationId } });
  assert.equal(generation.status, "abandoned");
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, 0);
});

// Behaviour: a revoked grant is refused on write and invisible on read, while the
// same caller is accepted before the revocation.
run("a revoked grant is refused on write and invisible on read", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { repoIndexRoutes } = await import(apiPath);
  const { db, scope } = await fixture();
  const uploaderToken = `uploader-${randomUUID()}`;
  const readerToken = `reader-${randomUUID()}`;
  await db.repoIndexGrant.createMany({
    data: [
      { scopeId: scope.id, kind: "uploader", principal: "sync-agent", tokenHash: sha256(uploaderToken) },
      { scopeId: scope.id, kind: "reader", principal: "search-agent", tokenHash: sha256(readerToken) },
    ],
  });
  await store.openAttempt(attemptFor(scope.id, "attempt-1", { partCount: 2 }));

  const writeUrl = `http://local/v1/repo-index/scopes/${scope.id}/generations/attempt-1/parts/1`;
  const accepted = await repoIndexRoutes.request(
    grantRequest("PUT", writeUrl, uploaderToken, { upserts: ["src/a.ts"], tombstones: [] }),
  );
  assert.equal(accepted.status, 202);

  await db.repoIndexGrant.updateMany({ where: { scopeId: scope.id, kind: "uploader" }, data: { revokedAt: new Date() } });
  const refusedWrite = await repoIndexRoutes.request(
    grantRequest("PUT", `http://local/v1/repo-index/scopes/${scope.id}/generations/attempt-1/parts/2`, uploaderToken, {
      upserts: ["src/b.ts"],
      tombstones: [],
    }),
  );
  assert.equal(refusedWrite.status, 403);

  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 2, part: { upserts: ["src/b.ts"], tombstones: [] } });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { partCount: 2 }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  const manifestUrl = `http://local/v1/repo-index/scopes/${scope.id}/manifest`;
  const read = await repoIndexRoutes.request(grantRequest("GET", manifestUrl, readerToken));
  assert.equal(read.status, 200);
  const manifest = (await read.json()) as any;
  assert.deepEqual(manifest.entries.map((item: any) => item.path).sort(), ["src/a.ts", "src/b.ts"]);

  await db.repoIndexGrant.updateMany({ where: { scopeId: scope.id, kind: "reader" }, data: { revokedAt: new Date() } });
  const refusedRead = await repoIndexRoutes.request(grantRequest("GET", manifestUrl, readerToken));
  assert.equal(refusedRead.status, 403);
  const refusedBody = (await refusedRead.json()) as any;
  assert.equal(refusedBody.entries, undefined);
});

// Behaviour: publishing needs more than upload rights, so an uploader grant cannot
// promote an attempt that already has its parts.
run("an uploader grant cannot publish an attempt", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { repoIndexRoutes } = await import(apiPath);
  const { db, scope } = await fixture();
  const uploaderToken = `uploader-${randomUUID()}`;
  const adminToken = `admin-${randomUUID()}`;
  await db.repoIndexGrant.createMany({
    data: [
      { scopeId: scope.id, kind: "uploader", principal: "sync-agent", tokenHash: sha256(uploaderToken) },
      { scopeId: scope.id, kind: "admin", principal: "publisher", tokenHash: sha256(adminToken) },
    ],
  });
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const finalizeUrl = `http://local/v1/repo-index/scopes/${scope.id}/generations/attempt-1/finalize`;
  const body = { requiredPaths: ["src/a.ts"], manifest: manifestFor("digest-1", [entry("src/a.ts")]) };

  const refused = await repoIndexRoutes.request(grantRequest("POST", finalizeUrl, uploaderToken, body));
  assert.equal(refused.status, 403);
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, 0);

  const accepted = await repoIndexRoutes.request(grantRequest("POST", finalizeUrl, adminToken, body));
  assert.equal(accepted.status, 201);
  const publishedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(publishedScope.activeGeneration, 1);
});

// Behaviour: the published receipt names the generation readers see, and it carries the
// digest the store recorded when it published that generation.
run("the published receipt names the generation readers see", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1"),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  const latest = await store.readReceipt({ scopeId: scope.id });
  const byAttempt = await store.readReceipt({ scopeId: scope.id, attemptId: "attempt-1" });
  const missing = await store.readReceipt({ scopeId: scope.id, attemptId: "attempt-other" });

  assert.equal(latest.code, store.STORE_CODE.OK);
  assert.equal(latest.receipt.generation, 1);
  assert.equal(latest.receipt.attemptId, "attempt-1");
  assert.equal(latest.receipt.receiptDigest, published.receiptDigest);
  assert.deepEqual(byAttempt.receipt, latest.receipt);
  assert.equal(missing.code, store.STORE_CODE.RECEIPT_NOT_PUBLISHED);
});

// Behaviour: finalizing a published attempt again answers its publication only while the manifest
// is the one that attempt declared. A retry with another manifest is a conflict; reporting the old
// receipt would claim this store published a tree it never wrote.
run("re-finalizing a published attempt with a changed manifest is refused", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { db, scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  const replay = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
  });
  const changed = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1", { manifestDigest: "digest-1" }),
    requiredPaths: ["src/b.ts"],
    manifest: manifestFor("digest-2", [entry("src/b.ts")]),
  });

  assert.equal(replay.code, store.STORE_CODE.PUBLISHED);
  assert.equal(replay.receiptDigest, published.receiptDigest);
  assert.equal(changed.code, store.STORE_CODE.ATTEMPT_CONFLICT);
  assert.equal(changed.receiptDigest, undefined);
  const generation = await db.repoIndexGeneration.findUniqueOrThrow({ where: { id: published.generationId } });
  assert.equal(generation.status, "published");
  assert.equal(generation.receiptDigest, published.receiptDigest);
  const storedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(storedScope.activeGeneration, 1);
  assert.equal(await db.repoIndexPath.count({ where: { scopeId: scope.id, path: "src/b.ts" } }), 0);
});

// Behaviour: pages of one manifest stay on the generation the cursor was issued for, so a
// caller that pages through a large tree never mixes two revisions.
run("a manifest cursor walks the pages of the generation it was issued for", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-1",
    partNo: 1,
    part: { upserts: ["src/a.ts", "src/b.ts"], tombstones: [] },
  });
  await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1"),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });

  const first = await store.readManifest({ scopeId: scope.id, limit: 1 });
  const second = await store.readManifest({ scopeId: scope.id, cursor: first.nextCursor, limit: 1 });

  assert.deepEqual(first.entries.map((item: any) => item.path), ["src/a.ts"]);
  assert.ok(first.nextCursor);
  assert.equal(second.generation, 1);
  assert.deepEqual(second.entries.map((item: any) => item.path), ["src/b.ts"]);
  assert.equal(second.nextCursor, null);
});

// Behaviour: a cursor for a generation that is no longer the published one is reported as
// expired, never satisfied from a newer generation's tree.
run("a cursor for a superseded generation is reported as expired", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { scope } = await fixture();
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts", "src/b.ts"], tombstones: [] } });
  await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1"),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });
  const pinned = await store.readManifest({ scopeId: scope.id, limit: 1 });
  assert.ok(pinned.nextCursor);

  await store.openAttempt(attemptFor(scope.id, "attempt-2", { baseGeneration: 1, revision: 2, manifestDigest: "digest-2" }));
  await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-2",
    partNo: 1,
    part: { upserts: ["src/c.ts"], tombstones: ["src/a.ts", "src/b.ts"] },
  });
  await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-2", { baseGeneration: 1, revision: 2, manifestDigest: "digest-2" }),
    requiredPaths: ["src/c.ts"],
    manifest: manifestFor("digest-2", [entry("src/c.ts")]),
  });

  const expired = await store.readManifest({ scopeId: scope.id, cursor: pinned.nextCursor });

  assert.equal(expired.code, store.STORE_CODE.GENERATION_EXPIRED);
  assert.equal(expired.generation, 1);
  assert.equal(expired.entries, undefined);
});

// Behaviour: the receipt route carries the receipt of the generation readers see, refuses an
// attempt that never published, and needs a reader grant at all.
run("the receipt route answers the published generation and nothing else", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { repoIndexRoutes } = await import(apiPath);
  const { db, scope } = await fixture();
  const readerToken = `reader-${randomUUID()}`;
  await grantsFor(db, scope.id, { reader: readerToken });
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1"),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
  });

  const url = `http://local/v1/repo-index/scopes/${scope.id}/receipt`;
  const read = await repoIndexRoutes.request(grantRequest("GET", url, readerToken));
  const body = (await read.json()) as any;
  assert.equal(read.status, 200);
  assert.equal(body.receipt.attemptId, "attempt-1");
  assert.equal(body.receipt.generation, 1);
  assert.equal(body.receipt.receiptDigest, published.receiptDigest);

  const unknown = await repoIndexRoutes.request(grantRequest("GET", `${url}?attemptId=attempt-other`, readerToken));
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as any).error.code, store.STORE_CODE.RECEIPT_NOT_PUBLISHED);

  const anonymous = await repoIndexRoutes.request(grantRequest("GET", url, undefined));
  assert.equal(anonymous.status, 403);
  assert.equal(((await anonymous.json()) as any).error.code, "GRANT_MISSING");
});

// Behaviour: abandoning is an admin capability, the same call again answers with the state it
// reached, and a published attempt is not abandoned. The uploader that stored the parts cannot.
run("the abandon route is admin-only and repeatable", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { repoIndexRoutes } = await import(apiPath);
  const { db, scope } = await fixture();
  const uploaderToken = `uploader-${randomUUID()}`;
  const adminToken = `admin-${randomUUID()}`;
  await grantsFor(db, scope.id, { uploader: uploaderToken, admin: adminToken });
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  const url = `http://local/v1/repo-index/scopes/${scope.id}/generations/attempt-1/abandon`;

  const uploaderAbandon = await repoIndexRoutes.request(grantRequest("POST", url, uploaderToken));
  assert.equal(uploaderAbandon.status, 403);
  assert.equal(((await uploaderAbandon.json()) as any).error.code, "GRANT_MISSING");
  const untouched = await db.repoIndexGeneration.findUniqueOrThrow({
    where: { scopeId_attemptId: { scopeId: scope.id, attemptId: "attempt-1" } },
  });
  assert.equal(untouched.status, "open");

  const abandoned = await repoIndexRoutes.request(grantRequest("POST", url, adminToken));
  assert.equal(abandoned.status, 200);
  assert.equal(((await abandoned.json()) as any).code, store.STORE_CODE.ABANDONED);
  const again = await repoIndexRoutes.request(grantRequest("POST", url, adminToken));
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as any).code, store.STORE_CODE.ALREADY_ABANDONED);

  await store.openAttempt(attemptFor(scope.id, "attempt-2", { manifestDigest: "digest-2" }));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-2", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-2", { manifestDigest: "digest-2" }),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-2", [entry("src/a.ts")]),
  });
  const publishedAbandon = await repoIndexRoutes.request(
    grantRequest("POST", `http://local/v1/repo-index/scopes/${scope.id}/generations/attempt-2/abandon`, adminToken),
  );
  assert.equal(publishedAbandon.status, 409);
  assert.equal(((await publishedAbandon.json()) as any).error.code, store.STORE_CODE.CANNOT_ABANDON_PUBLISHED);
});

// Behaviour: a paused scope serves nothing and accepts nothing, and says so with its own code
// instead of pretending the grant is missing or that the scope was withdrawn.
run("a paused scope refuses every capability", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { repoIndexRoutes } = await import(apiPath);
  const { db, scope } = await fixture();
  const readerToken = `reader-${randomUUID()}`;
  const uploaderToken = `uploader-${randomUUID()}`;
  const adminToken = `admin-${randomUUID()}`;
  await grantsFor(db, scope.id, { reader: readerToken, uploader: uploaderToken, admin: adminToken });
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-1"),
    requiredPaths: ["src/a.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts")]),
  });
  await db.repoIndexScope.update({ where: { id: scope.id }, data: { state: "paused" } });

  const base = `http://local/v1/repo-index/scopes/${scope.id}`;
  const attempts = [
    { method: "GET", url: `${base}/manifest`, token: readerToken, body: undefined },
    { method: "GET", url: `${base}/receipt`, token: readerToken, body: undefined },
    { method: "PUT", url: `${base}/generations/attempt-2/parts/1`, token: uploaderToken, body: { upserts: ["src/b.ts"], tombstones: [] } },
    { method: "PUT", url: `${base}/generations/attempt-2`, token: uploaderToken, body: { baseGeneration: 1, revision: 2, manifestDigest: "digest-2", partCount: 1 } },
    {
      method: "POST",
      url: `${base}/generations/attempt-2/finalize`,
      token: adminToken,
      body: { requiredPaths: [], manifest: manifestFor("digest-2", []) },
    },
    { method: "POST", url: `${base}/generations/attempt-2/abandon`, token: adminToken, body: undefined },
  ];
  for (const request of attempts) {
    const response = await repoIndexRoutes.request(grantRequest(request.method, request.url, request.token, request.body));
    assert.equal(response.status, 409, `${request.method} ${request.url}`);
    assert.equal(((await response.json()) as any).error.code, "SCOPE_PAUSED", `${request.method} ${request.url}`);
  }

  const manifest = await store.readManifest({ scopeId: scope.id });
  const receipt = await store.readReceipt({ scopeId: scope.id });
  // The refusal vocabulary belongs to the publication fence (PROMOTION_OUTCOME), which is what the
  // HTTP assertions above already read; STORE_CODE holds only this store's own outcomes, so its
  // lack of a SCOPE_PAUSED member is not a refusal this test can assert against.
  assert.equal(manifest.code, PROMOTION_OUTCOME.SCOPE_PAUSED);
  assert.equal(receipt.code, PROMOTION_OUTCOME.SCOPE_PAUSED);
});

// Behaviour: a revoked scope is refused as revoked over HTTP, not as withdrawn. The two states are
// different outcomes, so a caller that reads SCOPE_WITHDRAWN stops retrying a scope that was only
// revoked, and one that reads SCOPE_REVOKED knows its grant is gone.
run("a revoked scope answers SCOPE_REVOKED over HTTP", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { repoIndexRoutes } = await import(apiPath);
  const { db, scope } = await fixture();
  const readerToken = `reader-${randomUUID()}`;
  await grantsFor(db, scope.id, { reader: readerToken });
  await db.repoIndexScope.update({ where: { id: scope.id }, data: { state: "revoked" } });

  const response = await repoIndexRoutes.request(
    grantRequest("GET", `http://local/v1/repo-index/scopes/${scope.id}/manifest`, readerToken),
  );

  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as any).error.code, PROMOTION_OUTCOME.SCOPE_REVOKED);
  const manifest = await store.readManifest({ scopeId: scope.id });
  assert.equal(manifest.code, PROMOTION_OUTCOME.SCOPE_REVOKED);
});

// Behaviour: requiredPaths is part of the finalize contract, so a caller has to declare what it
// expects; an explicit empty list is still allowed, and a missing key is refused before any work.
run("finalize requires requiredPaths and accepts an explicit empty list", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { repoIndexRoutes } = await import(apiPath);
  const { db, scope } = await fixture();
  const adminToken = `admin-${randomUUID()}`;
  await grantsFor(db, scope.id, { admin: adminToken });
  await store.openAttempt(attemptFor(scope.id, "attempt-1"));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const url = `http://local/v1/repo-index/scopes/${scope.id}/generations/attempt-1/finalize`;
  const manifest = manifestFor("digest-1", [entry("src/a.ts")]);

  const silent = await repoIndexRoutes.request(
    grantRequest("POST", url, adminToken, { manifest }),
  );
  assert.equal(silent.status, 400);
  const unpublished = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(unpublished.activeGeneration, 0);

  const explicit = await repoIndexRoutes.request(
    grantRequest("POST", url, adminToken, { requiredPaths: [], manifest }),
  );
  assert.equal(explicit.status, 201);
  // A publication made by this route is metadata only: no content is supplied, so no chunk is
  // written, and the answer has to say that rather than let PUBLISHED imply a searchable tree.
  const publishedBody = (await explicit.json()) as any;
  assert.equal(publishedBody.code, store.STORE_CODE.PUBLISHED);
  assert.equal(publishedBody.searchable, false);
  assert.equal(publishedBody.materialisedChunks, 0);
  const publishedScope = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(publishedScope.activeGeneration, 1);
});

// Behaviour: a refused finalize tells the caller which part numbers are missing and which paths it
// dropped without declaring, so the next attempt can be different.
run("a refused finalize reports the parts and drops it refused", { timeout: 30_000 }, async () => {
  const store = await import(storePath);
  const { repoIndexRoutes } = await import(apiPath);
  const { db, scope } = await fixture();
  const adminToken = `admin-${randomUUID()}`;
  await grantsFor(db, scope.id, { admin: adminToken });
  await store.openAttempt(attemptFor(scope.id, "attempt-1", { partCount: 2 }));
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-1", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const url = `http://local/v1/repo-index/scopes/${scope.id}/generations/attempt-1/finalize`;
  const missing = await repoIndexRoutes.request(
    grantRequest("POST", url, adminToken, {
      requiredPaths: ["src/a.ts", "src/b.ts"],
      manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
    }),
  );
  assert.equal(missing.status, 409);
  assert.deepEqual(((await missing.json()) as any).error.missingParts, [2]);

  await store.openAttempt(attemptFor(scope.id, "attempt-good", { partCount: 1 }));
  const accepted = await store.putPart({
    scopeId: scope.id,
    attemptId: "attempt-good",
    partNo: 1,
    part: { upserts: ["src/a.ts", "src/b.ts"], tombstones: [] },
  });
  assert.equal(accepted.code, store.STORE_CODE.PART_ACCEPTED);
  const published = await store.finalizeAttempt({
    ...attemptFor(scope.id, "attempt-good", { partCount: 1 }),
    requiredPaths: ["src/a.ts", "src/b.ts"],
    manifest: manifestFor("digest-1", [entry("src/a.ts"), entry("src/b.ts")]),
  });
  assert.equal(published.code, store.STORE_CODE.PUBLISHED);

  await store.openAttempt(
    attemptFor(scope.id, "attempt-drop", { baseGeneration: published.generation, revision: 2, manifestDigest: "digest-2" }),
  );
  await store.putPart({ scopeId: scope.id, attemptId: "attempt-drop", partNo: 1, part: { upserts: ["src/a.ts"], tombstones: [] } });
  const dropped = await repoIndexRoutes.request(
    grantRequest("POST", `http://local/v1/repo-index/scopes/${scope.id}/generations/attempt-drop/finalize`, adminToken, {
      requiredPaths: ["src/a.ts"],
      manifest: manifestFor("digest-2", [entry("src/a.ts")]),
    }),
  );
  assert.equal(dropped.status, 409);
  const droppedBody = (await dropped.json()) as any;
  assert.equal(droppedBody.error.code, store.STORE_CODE.UNDECLARED_DROP);
  assert.deepEqual(droppedBody.error.undeclaredDrops, ["src/b.ts"]);
});

after(async () => {
  if (!databaseUrl) return;
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
  await client.$disconnect();
  process.env = savedEnvironment;
});
