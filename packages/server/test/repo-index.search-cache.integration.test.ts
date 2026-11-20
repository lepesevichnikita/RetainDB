/**
 * A publication must invalidate the search answers that were cached before it.
 *
 * Two caches answer a search for one project, and neither key names the generation or the content
 * revision its answer was computed from:
 *
 * - `engine/retriever.ts` keys a context answer `whisper:context:query:<projectId>:<hash(params)>`
 *   and keeps it for 300 seconds. A publication that adds a path, or one that drops it, changes the
 *   rows that answer describes, and the key carries nothing that says so.
 * - `engine/memory/search.ts` keys a memory answer
 *   `whisper:context:search:<projectId>:<userId>:<scope>:<query>` and caches an EMPTY answer for 60
 *   seconds. An empty array is truthy, so the next identical search answers from that entry instead
 *   of reading the rows again.
 *
 * `invalidateProjectAnswers` in `store.ts` is what keeps both current: it drops every answer of one
 * project by pattern, and it runs after a committed publication, a withdrawal and a grant
 * revocation. This file pins that contract from the outside: a search, then a real publication
 * through the store's own publish transaction (or a real admin route), then the same search - in
 * one process, so the cache under test is the one the first search wrote.
 *
 * The published chunks and the query are embedded by the same in-process model
 * (`EMBEDDING_MODE=local`), so "the published content is found" is a real vector match and nothing
 * calls a provider.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { AuthContext } from "../src/middleware/auth.js";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "RETAINDB_TEST_DATABASE_URL must name a migrated PostgreSQL database: this file publishes real generations and skips nothing",
  );
}
process.env.DATABASE_URL = databaseUrl;
// One model for the published chunk text and for the query text; without it the two vectors would
// come from different spaces and "found" would prove nothing.
process.env.EMBEDDING_MODE = "local";
const savedEnvironment = { ...process.env };

/** Every scope and project this file created, removed and counted in `after`. */
const scopeIds: string[] = [];
const projectIds: string[] = [];

const dbPath = "../src/db/index.js";
const storePath = "../src/engine/repo-index/store.js";
const embeddingsPath = "../src/engine/embeddings.js";
const retrieverPath = "../src/engine/retriever.js";
const memorySearchPath = "../src/engine/memory/search.js";
const receiptPath = "../src/engine/repo-index/receipt.js";
const adminPath = "../src/api/repo-index-admin.js";
const grantTokenPath = "../src/engine/repo-index/grant-token.js";

/** A sha256 digest of some text: the manifest entry and the document row carry the same one. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The vector the publication fence requires per manifest path: a stable pseudo-vector derived from
 * a seed, every element finite and inside [-1, 1] and never exactly zero. It stands in for the
 * connector's digest-derived vector; the chunk vectors are the model's own.
 */
function pathVector(seed: string, dimensions: number): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < dimensions; block++) {
    const bytes = createHash("sha256").update(`${seed}:${block}`, "utf8").digest();
    for (const byte of bytes) {
      if (vector.length === dimensions) break;
      vector.push((byte / 255) * 2 - 1);
    }
  }
  return vector;
}

/** One project and one active repository scope inside it, both removed in `after`. */
async function fixtureScope() {
  const { db } = await import(dbPath);
  const client = db as any;
  const name = `search-cache-${randomUUID()}`;
  const project = await client.project.create({ data: { name, slug: name, orgId: "default" } });
  projectIds.push(project.id);
  const scope = await client.repoIndexScope.create({
    data: {
      projectId: project.id,
      repoHost: "git.example.invalid",
      repoExternalId: `repo-${name}`,
      worktreePath: `/worktrees/${name}`,
      deviceId: `device-${name}`,
      ref: "refs/heads/main",
      headCommit: "0".repeat(40),
      policyVersion: "policy-1",
      pipelineVersion: "pipeline-1",
    },
  });
  scopeIds.push(scope.id);
  return { client, project, scope };
}

/**
 * Publishes one generation through the real publish path: `openAttempt` declares it against the
 * generation the caller observed, one part declares the paths it upserts and the paths it drops,
 * and `finalizeAttempt` runs the fence, writes the path rows and materialises the chunks - reading
 * the file contents this call holds and embedding them with the production embedder.
 *
 * The tombstone argument is what the store's drop guard requires: a manifest that omits a present
 * path is a deletion, and it has to be declared before the manifest is seen.
 */
async function publish(options: {
  scopeId: string;
  baseGeneration: number;
  files: ReadonlyArray<{ path: string; content: string }>;
  tombstones?: string[];
}) {
  const store = await import(storePath);
  const { embed } = await import(embeddingsPath);
  const { EMBEDDING_DIMENSIONS } = await import(receiptPath);
  const attemptId = randomUUID();
  const manifestDigest = digestOf(options.files.map((file) => `${file.path}\n${digestOf(file.content)}`).join("\n"));

  const opened = await store.openAttempt({
    scopeId: options.scopeId,
    attemptId,
    baseGeneration: options.baseGeneration,
    revision: options.baseGeneration + 1,
    manifestDigest,
    partCount: 1,
  });
  assert.equal(opened.code, store.STORE_CODE.ATTEMPT_OPEN, `the attempt opens against generation ${options.baseGeneration}: ${opened.code}`);

  const part = await store.putPart({
    scopeId: options.scopeId,
    attemptId,
    partNo: 1,
    part: { upserts: options.files.map((file) => file.path), tombstones: options.tombstones ?? [] },
  });
  assert.equal(part.code, store.STORE_CODE.PART_ACCEPTED, `the one part is accepted: ${part.code}`);

  const contents = new Map(options.files.map((file) => [file.path, file.content] as const));
  return store.finalizeAttempt({
    scopeId: options.scopeId,
    attemptId,
    requiredPaths: options.files.map((file) => file.path),
    manifest: {
      digest: manifestDigest,
      dimensions: EMBEDDING_DIMENSIONS,
      entries: options.files.map((file) => ({
        path: file.path,
        digest: digestOf(file.content),
        vector: pathVector(`fence:${file.path}`, EMBEDDING_DIMENSIONS),
        lineStart: 1,
        lineEnd: 1,
      })),
    },
    readContent: async (path: string) => contents.get(path) ?? "",
    embed,
  });
}

/** The production search for published content: the same call POST /v1/context/query makes. */
async function search(projectId: string, query: string, overrides: { useCache?: boolean } = {}) {
  const { retrieve } = await import(retrieverPath);
  return retrieve({
    projectId,
    query,
    retrievalProfile: "legacy",
    useCache: overrides.useCache ?? true,
    topK: 5,
    threshold: 0.25,
    rerank: false,
    compress: false,
    hybridSearch: true,
  });
}

/** The production memory search, with the diagnostics that say whether the cache answered. */
async function memorySearch(projectId: string, query: string) {
  const { searchMemories } = await import(memorySearchPath);
  let cacheHitType = "not collected";
  const results = await searchMemories({
    query,
    questionDate: new Date(),
    projectId,
    orgId: "default",
    topK: 5,
    fastMode: true,
    diagnosticsCollector: (diagnostics: { cache_hit_type: string }) => {
      cacheHitType = diagnostics.cache_hit_type;
    },
  });
  return { results, cacheHitType };
}

/** The repository paths an answer names: the metadata materialisation writes on every chunk. */
function answeredPaths(answer: { results: Array<{ metadata?: Record<string, unknown> }> }): string[] {
  return answer.results.map((entry) => String(entry.metadata?.repo_path ?? ""));
}

/** The admin surface composed the way routes.ts composes it: the credential middleware stubbed. */
async function adminApp() {
  const { repoIndexAdminRoutes } = await import(adminPath);
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("/*", async (c, next) => {
    c.set("auth", { orgId: "default", authType: "api_key" } satisfies AuthContext);
    await next();
  });
  app.route("/", repoIndexAdminRoutes);
  return app;
}

/**
 * Behaviour: the required scenario, in one process - search, publish, search. The first search
 * answers "nothing" on both surfaces: the retrieval surface caches nothing, and the memory surface
 * caches that empty answer for 60 seconds. The publication must invalidate that answer, and the
 * published chunk must be found by the same query.
 */
test("a publication is found by the search that ran before it", { timeout: 180_000 }, async () => {
  const { project, scope } = await fixtureScope();
  const query = "how does the flux capacitor regulate the chronometer";

  // 1. Nothing is published yet, so the retrieval answer is empty and the memory answer is empty.
  const before = await search(project.id, query);
  assert.deepEqual(before.results, [], "nothing is published, so the production search answers nothing");
  const poisoned = await memorySearch(project.id, query);
  assert.deepEqual(poisoned.results, [], "no memory matches this query either");
  assert.equal(poisoned.cacheHitType, "none", "the first memory answer is computed, not cached");
  // The empty answer is now cached for 60 seconds: a second identical search answers from it.
  // This is the poison the publication below has to clear.
  const poisonedAgain = await memorySearch(project.id, query);
  assert.equal(poisonedAgain.cacheHitType, "simple", "the empty memory answer really is cached");

  // 2. Publish a generation that contains a chunk matching that query.
  const published = await publish({
    scopeId: scope.id,
    baseGeneration: 0,
    files: [{ path: "docs/retrieval-target.md", content: "# Retrieval target\n\nThe flux capacitor regulates the chronometer while the reactor is warm.\n" }],
  });
  assert.equal(published.code, "PUBLISHED", `the generation is published: ${published.code}`);
  assert.equal(published.materialise?.chunks, 1, "the published path is one searchable chunk");

  // 3. The same query must find the published content, and must not answer from the cache that
  //    held "nothing" a moment ago.
  const after = await search(project.id, query);
  assert.deepEqual(answeredPaths(after), ["docs/retrieval-target.md"], "the published path is what the same query now returns");
  assert.match(after.context, /flux capacitor/i, "the answer carries the published text");
  const afterMemory = await memorySearch(project.id, query);
  assert.equal(afterMemory.cacheHitType, "none", "the empty answer cached before the publication is gone");
  assert.deepEqual(afterMemory.results, [], "a publication adds no memory, and this answer is read fresh");
});

/**
 * Behaviour: a publication that ADDS a path must invalidate the answer cached before it. The first
 * search is answered by the generation that exists; the second must include the path the
 * publication added, which a cached answer cannot know about.
 */
test("a publication invalidates the answer a search cached before it", { timeout: 180_000 }, async () => {
  const { project, scope } = await fixtureScope();
  const query = "where is the backup rotation documented";

  const first = await publish({
    scopeId: scope.id,
    baseGeneration: 0,
    files: [{ path: "docs/rotation.md", content: "# Backups\n\nThe backup rotation replaces the verified backup every night.\n" }],
  });
  assert.equal(first.code, "PUBLISHED", `the first generation is published: ${first.code}`);

  const cached = await search(project.id, query);
  assert.deepEqual(answeredPaths(cached), ["docs/rotation.md"], "the first generation answers the query");

  const second = await publish({
    scopeId: scope.id,
    baseGeneration: 1,
    files: [
      { path: "docs/rotation.md", content: "# Backups\n\nThe backup rotation replaces the verified backup every night.\n" },
      { path: "docs/restore.md", content: "# Restore\n\nThe backup rotation is what the restore reads, and the restore is verified monthly.\n" },
    ],
  });
  assert.equal(second.code, "PUBLISHED", `the second generation is published: ${second.code}`);

  const after = await search(project.id, query);
  assert.ok(
    answeredPaths(after).includes("docs/restore.md"),
    `the path the publication added answers the query too: ${JSON.stringify(answeredPaths(after))}`,
  );
  assert.equal(after.meta.cacheHit, false, "the answer is recomputed, not served from the cache the first search filled");
});

/**
 * Behaviour: a publication that DROPS a path must invalidate the answer cached before it. The
 * dropped path is no longer part of the published tree, so a search must not keep returning it.
 */
test("a publication that drops a path stops serving it", { timeout: 180_000 }, async () => {
  const { project, scope } = await fixtureScope();
  const query = "which document describes the release checklist";

  const kept = { path: "docs/checklist.md", content: "# Release checklist\n\nThe release checklist is signed before the tag is pushed.\n" };
  const dropped = { path: "docs/old-checklist.md", content: "# Old release checklist\n\nThe release checklist used to live in this file, which is retired now.\n" };
  const first = await publish({ scopeId: scope.id, baseGeneration: 0, files: [kept, dropped] });
  assert.equal(first.code, "PUBLISHED", `both paths are published first: ${first.code}`);

  const cached = await search(project.id, query);
  assert.deepEqual(answeredPaths(cached).sort(), ["docs/checklist.md", "docs/old-checklist.md"], "both published paths answer the query");

  const second = await publish({ scopeId: scope.id, baseGeneration: 1, files: [kept], tombstones: [dropped.path] });
  assert.equal(second.code, "PUBLISHED", `the drop is published: ${second.code}`);

  const after = await search(project.id, query);
  assert.deepEqual(answeredPaths(after), ["docs/checklist.md"], "the dropped path is gone from the answer, the kept one stays");
});

/**
 * Behaviour: a withdrawn scope stops being visible to a search that answered while it was active,
 * and it stops being visible while every row it published stays in the database.
 *
 * The pair is the point. Withdrawal is terminal, so deleting the content it made searchable would be
 * an irreversible answer; the content is therefore retired by the read path - a search may not return
 * a chunk of a scope `isScopeReadable` refuses - and not by a delete. Both halves are asserted here:
 * the answer is empty, and the rows are still there.
 */
test("a withdrawn scope is invisible to search while its rows are retained", { timeout: 180_000 }, async () => {
  const { client, project, scope } = await fixtureScope();
  const query = "who approves the quarterly access review";

  const published = await publish({
    scopeId: scope.id,
    baseGeneration: 0,
    files: [{ path: "docs/access-review.md", content: "# Access review\n\nThe quarterly access review is approved by the security lead.\n" }],
  });
  assert.equal(published.code, "PUBLISHED", `the generation is published: ${published.code}`);

  const cached = await search(project.id, query);
  assert.deepEqual(answeredPaths(cached), ["docs/access-review.md"], "the active scope answers the query");

  // What the publication wrote, read from the database rather than assumed: the counts below are
  // the rows a withdrawal has to leave behind.
  const retained = await publishedRows(client, project.id, scope.id);
  assert.deepEqual(retained, { sources: 1, documents: 1, chunks: 1, paths: 1 },
    "the publication wrote one source, one document, its one chunk and its one manifest path");

  const app = await adminApp();
  const response = await app.request(`/v1/repo-index/admin/scopes/${scope.id}/withdraw`, { method: "POST" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).code, "WITHDRAW_APPLIED");

  // The cached answer must not survive the withdrawal.
  const after = await search(project.id, query);
  assert.equal(after.meta?.cacheHit ?? false, false, "the answer cached before the withdrawal is gone");

  // Invisible: an uncached search returns none of it. This is the read-time filter, so the answer
  // is empty for a recomputed search and not only for the one the cache used to serve.
  const withoutCache = await search(project.id, query, { useCache: false });
  assert.deepEqual(answeredPaths(withoutCache), [],
    "a withdrawn scope's content is not returned by an uncached search");

  // Retained: the invisibility came from filtering, so every row the publication wrote is still
  // there. Comparing against the counts taken before the withdrawal is what makes this a statement
  // about retention; asserting zero on both sides would pass on a database that never had them.
  assert.deepEqual(await publishedRows(client, project.id, scope.id), retained,
    "the withdrawal deletes nothing: every row it published is still in the database");

  const scopeRow = await client.repoIndexScope.findUnique({ where: { id: scope.id }, select: { state: true } });
  assert.equal(scopeRow.state, "withdrawn", "the scope row is what changed, not the content it published");
});

/**
 * Behaviour: revoking a grant invalidates the answers cached for that project. The published tree
 * itself is untouched - a credential is not content - so the recomputed answer still finds it.
 */
test("a revoked grant invalidates the answer a search cached under it", { timeout: 180_000 }, async () => {
  const { project, scope, client } = await fixtureScope();
  const query = "when is the on call rotation published";

  const published = await publish({
    scopeId: scope.id,
    baseGeneration: 0,
    files: [{ path: "docs/on-call.md", content: "# On call\n\nThe on call rotation is published every Thursday afternoon.\n" }],
  });
  assert.equal(published.code, "PUBLISHED", `the generation is published: ${published.code}`);

  const { mintGrantToken } = await import(grantTokenPath);
  const grant = await client.repoIndexGrant.create({
    data: { scopeId: scope.id, kind: "admin", principal: "release-owner", tokenHash: mintGrantToken().tokenHash },
  });

  const cached = await search(project.id, query);
  assert.deepEqual(answeredPaths(cached), ["docs/on-call.md"], "the published path answers the query");
  assert.equal(cached.meta.cacheHit, false, "the first answer is computed");

  const app = await adminApp();
  const response = await app.request(`/v1/repo-index/admin/scopes/${scope.id}/grants/${grant.id}/revoke`, { method: "POST" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).code, "GRANT_REVOKED");

  const after = await search(project.id, query);
  assert.equal(after.meta.cacheHit, false, "the revoke cleared the cached answer for this project");
  assert.deepEqual(answeredPaths(after), ["docs/on-call.md"], "a revoked grant retires no content: the tree is still there");
});

/**
 * The rows one publication leaves in the database, counted straight from the tables - so a claim
 * that a withdrawal retained them is measured, not inferred from a search answering nothing.
 *
 * The four counts are the whole of what materialisation writes for a scope: its synthetic source,
 * one document per manifest path, the searchable chunks of those documents, and the manifest rows.
 */
async function publishedRows(client: any, projectId: string, scopeId: string) {
  return {
    sources: await client.source.count({ where: { projectId } }),
    documents: await client.document.count({ where: { projectId } }),
    chunks: await client.chunk.count({ where: { projectId } }),
    paths: await client.repoIndexPath.count({ where: { scopeId } }),
  };
}

/** Every table this file writes to, counted for the rows it created. */
async function countsOf(client: any) {
  return {
    scopes: await client.repoIndexScope.count({ where: { id: { in: scopeIds } } }),
    grants: await client.repoIndexGrant.count({ where: { scopeId: { in: scopeIds } } }),
    generations: await client.repoIndexGeneration.count({ where: { scopeId: { in: scopeIds } } }),
    parts: await client.repoIndexPart.count({ where: { generation: { scopeId: { in: scopeIds } } } }),
    paths: await client.repoIndexPath.count({ where: { scopeId: { in: scopeIds } } }),
    sources: await client.source.count({ where: { projectId: { in: projectIds } } }),
    documents: await client.document.count({ where: { projectId: { in: projectIds } } }),
    chunks: await client.chunk.count({ where: { projectId: { in: projectIds } } }),
  };
}

after(async () => {
  const { db } = await import(dbPath);
  const client = db as any;
  try {
    // The scope owns its grants, generations, parts and paths: one delete takes all of them.
    if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
    // The synthetic source, its documents and their chunks hang off the project.
    if (projectIds.length > 0) await client.project.deleteMany({ where: { id: { in: projectIds } } });

    // Proven empty, not assumed: every table this file wrote to holds none of its rows.
    assert.deepEqual(await countsOf(client), {
      scopes: 0,
      grants: 0,
      generations: 0,
      parts: 0,
      paths: 0,
      sources: 0,
      documents: 0,
      chunks: 0,
    });
  } finally {
    await client.$disconnect();
    process.env = savedEnvironment;
  }
});
