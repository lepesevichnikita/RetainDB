import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Hono } from "hono";
import { mintGrantToken } from "../src/engine/repo-index/grant-token.js";
import { scopeSourceName, type Embedder } from "../src/engine/repo-index/materialise.js";
import { EMBEDDING_DIMENSIONS } from "../src/engine/repo-index/receipt.js";
import type { AuthContext } from "../src/middleware/auth.js";
import type { FinalizeInput } from "../src/engine/repo-index/store.js";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const savedEnvironment = { ...process.env };
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
} else {
  /**
   * The store builds a Prisma client as it loads, so the process needs a well-formed URL even
   * when every database test is skipped below. Nothing reaches this address.
   */
  process.env.DATABASE_URL = "postgresql://materialise:test@127.0.0.1:1/unreachable";
}

const materialisePath = "../src/engine/repo-index/materialise.js";
const storePath = "../src/engine/repo-index/store.js";
const scopeIds: string[] = [];
const projectIds: string[] = [];

/** A 1024-dimension vector the store's fence accepts; the width is the one chunks.embedding stores. */
function vectors(texts: string[]): number[][] {
  return texts.map((text) => {
    const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    vector[0] = 1;
    vector[1] = text.length / 1000;
    return vector;
  });
}

// Behaviour: a path whose digest the previous generation already materialised is reused, so an
// unchanged reread costs no content read, no chunking and, above all, no re-embedding.
test("an unchanged digest is reused instead of re-embedded", async () => {
  const { prepareMaterialisation } = await import(materialisePath);
  const reads: string[] = [];
  const embedded: string[] = [];

  const prepared = await prepareMaterialisation({
    paths: [{ path: "src/a.ts", digest: "digest-a" }],
    previous: new Map([["src/a.ts", { digest: "digest-a", chunkIds: ["chunk-a"] }]]),
    readContent: async (path: string) => {
      reads.push(path);
      return "export const a = 1;";
    },
    embed: async (texts: string[]) => {
      embedded.push(...texts);
      return vectors(texts);
    },
  });

  assert.deepEqual(prepared.reuse.map((entry: { path: string }) => entry.path), ["src/a.ts"]);
  assert.deepEqual(prepared.pending, []);
  assert.deepEqual(reads, [], "unchanged content is not even read again");
  assert.deepEqual(embedded, [], "unchanged content is never re-embedded");
});

// Behaviour: a previous document with the same digest but no stored chunk ids cannot stand in for
// materialisation; the path must be embedded again or the generation would publish an empty anchor.
test("a previous digest without chunk ids is not reused", async () => {
  const { prepareMaterialisation } = await import(materialisePath);

  const prepared = await prepareMaterialisation({
    paths: [{ path: "src/a.ts", digest: "digest-a" }],
    previous: new Map([["src/a.ts", { digest: "digest-a", chunkIds: [] }]]),
    readContent: async () => "export const a = 1;",
    embed: async (texts: string[]) => vectors(texts),
  });

  assert.deepEqual(prepared.reuse, []);
  assert.equal(prepared.pending.length, 1);
});

// Behaviour: a digest the previous generation did not materialise is read, chunked and embedded,
// which is how a changed file becomes a new set of searchable chunks.
test("a changed digest is chunked and embedded again", async () => {
  const { prepareMaterialisation } = await import(materialisePath);
  const reads: string[] = [];

  const prepared = await prepareMaterialisation({
    paths: [{ path: "src/a.ts", digest: "digest-new" }],
    previous: new Map([["src/a.ts", { digest: "digest-old", chunkIds: ["chunk-old"] }]]),
    readContent: async (path: string) => {
      reads.push(path);
      return "export function changed() {\n  return 2;\n}";
    },
    embed: async (texts: string[]) => vectors(texts),
  });

  assert.deepEqual(reads, ["src/a.ts"]);
  assert.equal(prepared.pending.length, 1);
  assert.ok(prepared.pending[0].chunks.length > 0);
  assert.ok(prepared.pending[0].chunks.every((entry: { vector: number[] }) => entry.vector.length === EMBEDDING_DIMENSIONS));
});
// Behaviour: the cap refuses an over-sized plan before a single vector is requested, so a huge
// generation fails the publication instead of holding the publish transaction open.
test("a plan above the chunk cap is refused before anything is embedded", async () => {
  const { prepareMaterialisation, MATERIALISE_CODE, MaterialiseError } = await import(materialisePath);
  let embedded = 0;

  await assert.rejects(
    prepareMaterialisation({
      paths: [{ path: "src/large.ts", digest: "digest-large" }],
      previous: new Map(),
      readContent: async () => "export const line = 1;\n".repeat(4000),
      embed: async (texts: string[]) => {
        embedded += texts.length;
        return vectors(texts);
      },
      maxChunks: 2,
    }),
    (error: { code?: string }) => error instanceof MaterialiseError && error.code === MATERIALISE_CODE.CHUNK_LIMIT,
  );
  assert.equal(embedded, 0, "the cap is decided before embedding starts");
});
// Behaviour: content that cannot be read fails materialisation and names the path, because
// publishing a path whose chunks were never created would claim a tree that cannot be searched.
test("content that cannot be read refuses the plan and names the path", async () => {
  const { prepareMaterialisation, MATERIALISE_CODE } = await import(materialisePath);
  let embedded = 0;

  await assert.rejects(
    prepareMaterialisation({
      paths: [{ path: "src/gone.ts", digest: "digest-gone" }],
      previous: new Map(),
      readContent: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
      embed: async (texts: string[]) => {
        embedded += texts.length;
        return vectors(texts);
      },
    }),
    (error: { code?: string; path?: string }) =>
      error.code === MATERIALISE_CODE.CONTENT_UNAVAILABLE && error.path === "src/gone.ts",
  );
  assert.equal(embedded, 0, "nothing is embedded for a path nothing could be read from");
});

// Behaviour: a reader that answers with nothing has no content for the path, exactly like one that
// throws. Refusing here is what keeps the failure in the reader's layer: passed on, the missing
// text fails later as a TypeError that names no path and carries no code, and a caller reads that
// as its own store failing rather than as content the connector could not supply.
test("content a reader cannot supply refuses the plan and names the path", async () => {
  const { prepareMaterialisation, MATERIALISE_CODE, MaterialiseError } = await import(materialisePath);
  let embedded = 0;

  await assert.rejects(
    prepareMaterialisation({
      paths: [{ path: "src/hollow.ts", digest: "digest-hollow" }],
      previous: new Map(),
      // An adapter outside this module's type promise: the reader has nothing for the path, which is
      // a content the boundary must judge rather than pass on.
      readContent: async () => undefined as unknown as string,
      embed: async (texts: string[]) => {
        embedded += texts.length;
        return vectors(texts);
      },
    }),
    (error: { code?: string; path?: string }) =>
      error instanceof MaterialiseError &&
      error.code === MATERIALISE_CODE.CONTENT_UNAVAILABLE &&
      error.path === "src/hollow.ts",
  );
  assert.equal(embedded, 0, "nothing is embedded for a path the reader had no text for");
});
// Behaviour: an embedder that answers with a vector semantic search cannot consume refuses the
// plan, because such a chunk would be stored searchable and never return a result.
test("an embedding that is not a usable vector refuses the plan", async () => {
  const { prepareMaterialisation, MATERIALISE_CODE } = await import(materialisePath);

  await assert.rejects(
    prepareMaterialisation({
      paths: [{ path: "src/a.ts", digest: "digest-a" }],
      previous: new Map(),
      readContent: async () => "export const a = 1;",
      embed: async () => [[1, 2, 3]],
    }),
    (error: { code?: string }) => error.code === MATERIALISE_CODE.EMBEDDING_UNAVAILABLE,
  );
});
// Behaviour: an empty file materialises no chunk at all; an empty searchable chunk would be a row
// with a vector and nothing to recall.
test("a path with no text materialises no chunk", async () => {
  const { prepareMaterialisation } = await import(materialisePath);
  let embedded = 0;

  const prepared = await prepareMaterialisation({
    paths: [{ path: "docs/empty.md", digest: "digest-empty" }],
    previous: new Map(),
    readContent: async () => "   \n\n",
    embed: async (texts: string[]) => {
      embedded += texts.length;
      return vectors(texts);
    },
  });

  assert.deepEqual(prepared.pending[0].chunks, []);
  assert.equal(embedded, 0);
});

/** A scope's own project, because a source row (which a document requires) points at a project. */
async function fixture() {
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  const name = `materialise-${randomUUID()}`;
  const project = await client.project.create({ data: { name, slug: name, orgId: "default" } });
  projectIds.push(project.id);
  const scope = await client.repoIndexScope.create({
    data: {
      projectId: project.id,
      repoHost: "github.com",
      repoExternalId: `repo-${name}`,
      worktreePath: `/worktrees/${name}`,
      deviceId: `device-${name}`,
      ref: "refs/heads/main",
      headCommit: "commit-0f0f",
      policyVersion: "policy-1",
      pipelineVersion: "pipeline-1",
    },
  });
  scopeIds.push(scope.id);
  return { db: client, project, scope };
}

/**
 * The finalize options this file injects, named from the store's own input type: a field the store
 * does not declare cannot reach materialisation, so naming them here makes the compiler refuse the
 * injector instead of a spread silently dropping the embedder.
 */
type FinalizeOptions = Pick<FinalizeInput, "readContent" | "embed">;

/**
 * Publishes one generation through the store's own entry points: open an attempt, store its part,
 * finalize it with a manifest the fence accepts. `options` carries the content reader and the
 * embedder under test, plus the deletions this attempt declares; each one is forwarded by name,
 * because a spread would let an option the store does not declare pass unnoticed.
 */
async function publishGeneration(
  client: any,
  scope: any,
  tree: Array<{ path: string; digest: string }>,
  options: FinalizeOptions & { tombstones?: string[] } = {},
) {
  const store = await import(storePath);
  const { tombstones = [], readContent, embed } = options;
  const attemptId = randomUUID();
  const current = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  const opened = await store.openAttempt({
    scopeId: scope.id,
    attemptId,
    baseGeneration: current.activeGeneration,
    revision: current.activeGeneration + 1,
    manifestDigest: `digest-${attemptId}`,
    partCount: 1,
  });
  assert.equal(opened.code, "ATTEMPT_OPEN");
  await store.putPart({
    scopeId: scope.id,
    attemptId,
    partNo: 1,
    part: { upserts: tree.map((entry) => entry.path), tombstones },
  });
  const manifest = {
    digest: `digest-${attemptId}`,
    dimensions: EMBEDDING_DIMENSIONS,
    entries: tree.map((entry) => ({ ...entry, vector: vectors([entry.path])[0] })),
  };
  return store.finalizeAttempt({
    scopeId: scope.id,
    attemptId,
    requiredPaths: tree.map((entry) => entry.path),
    manifest,
    readContent,
    embed,
  });
}

/** The chunk ids a manifest path anchors, with the width of each stored vector. */
async function anchoredChunks(client: any, scopeId: string) {
  return client.$queryRaw`
    SELECT p."path", p."chunkId", c."content", vector_dims(c."embedding") AS dimensions
    FROM "repo_index_paths" p
    LEFT JOIN "chunks" c ON c."id" = p."chunkId"
    WHERE p."scopeId" = ${scopeId} AND p."state" = 'present'
    ORDER BY p."path"
  `;
}

// Behaviour: a published generation becomes searchable. Every path row names a chunk whose vector
// has the width semantic search reads, and that chunk belongs to the scope's project.
run("publishing with a content reader embeds a chunk and names it on the path row", async () => {
  const { db, project, scope } = await fixture();
  const tree = [
    { path: "src/alpha.ts", digest: "digest-alpha" },
    { path: "src/beta.ts", digest: "digest-beta" },
  ];

  const published = await publishGeneration(db, scope, tree, {
    readContent: async (path: string) => `export const value = "${path}";`,
    embed: async (texts: string[]) => vectors(texts),
  });
  assert.equal(published.code, "PUBLISHED");

  const rows = await anchoredChunks(db, scope.id);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.chunkId, `path ${row.path} names no chunk`);
    assert.equal(row.dimensions, EMBEDDING_DIMENSIONS);
  }
  const stored = await db.chunk.findMany({
    where: { id: { in: rows.map((row: { chunkId: string }) => row.chunkId) } },
    include: { document: { include: { source: true } } },
  });
  assert.ok(stored.every((chunk: any) => chunk.projectId === project.id));
  assert.ok(stored.every((chunk: any) => chunk.document.source.type === "repo_index"));
});

// Behaviour: republishing an unchanged tree rewrites the path rows but reuses the chunk ids, so a
// reread of an untouched repository causes zero document re-embeddings. The same counting embedder
// is asserted on the first publication as well: an embedder the store never received cannot be
// evidence that nothing was re-embedded, so "embedded nothing" is only a claim once "embedded
// something" has been observed through the same seam.
run("republishing an unchanged tree reuses its chunk ids and embeds nothing", async () => {
  const { db, project, scope } = await fixture();
  const tree = [{ path: "src/alpha.ts", digest: "digest-alpha" }];
  const content = async (path: string) => `export const value = "${path}";`;
  let embedded = 0;
  const countingEmbedder: Embedder = async (texts) => {
    embedded += texts.length;
    return vectors(texts);
  };

  const first = await publishGeneration(db, scope, tree, { readContent: content, embed: countingEmbedder });
  assert.equal(first.code, "PUBLISHED");
  assert.ok(embedded > 0, "the first publication embeds the path it holds no chunks for yet");
  assert.ok(first.materialise, "a publication that materialised reports what it wrote");
  assert.equal(first.materialise?.created, 1);
  const before = await anchoredChunks(db, scope.id);
  const chunksBefore = await db.chunk.count({ where: { projectId: project.id } });

  embedded = 0;
  const second = await publishGeneration(db, scope, tree, { readContent: content, embed: countingEmbedder });
  assert.equal(second.code, "PUBLISHED");

  const after = await anchoredChunks(db, scope.id);
  assert.equal(embedded, 0, "an unchanged tree is never re-embedded");
  assert.equal(second.materialise?.reused, 1, "the unchanged path is reused, not re-created");
  assert.equal(second.materialise?.chunks, 0, "a reused path writes no chunk row");
  assert.deepEqual(after.map((row: any) => row.chunkId), before.map((row: any) => row.chunkId));
  assert.equal(await db.chunk.count({ where: { projectId: project.id } }), chunksBefore);
});

// Behaviour: a generation whose content cannot be read is not published and does not replace the
// previous tree, so search keeps serving the last generation that was fully materialised. The
// attempt below is the one that has to read the path: a digest the published generation never
// materialised, because an unchanged digest is reused without a read and would never reach the
// reader at all (see the reuse behaviours above).
run("a path whose content is unavailable leaves the generation unpublished and the old tree live", async () => {
  const { db, scope } = await fixture();
  const published = [{ path: "src/alpha.ts", digest: "digest-alpha" }];
  const changed = [{ path: "src/alpha.ts", digest: "digest-alpha-changed" }];

  const first = await publishGeneration(db, scope, published, {
    readContent: async () => "export const value = 1;",
    embed: async (texts: string[]) => vectors(texts),
  });
  assert.equal(first.code, "PUBLISHED");
  const before = await anchoredChunks(db, scope.id);
  assert.equal(before.length, 1);

  let attemptId = "";
  await assert.rejects(
    (async () => {
      const store = await import(storePath);
      attemptId = randomUUID();
      const current = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
      await store.openAttempt({
        scopeId: scope.id,
        attemptId,
        baseGeneration: current.activeGeneration,
        revision: 2,
        manifestDigest: `digest-${attemptId}`,
        partCount: 1,
      });
      await store.putPart({ scopeId: scope.id, attemptId, partNo: 1, part: { upserts: changed.map((e) => e.path), tombstones: [] } });
      return store.finalizeAttempt({
        scopeId: scope.id,
        attemptId,
        requiredPaths: changed.map((e) => e.path),
        manifest: { digest: `digest-${attemptId}`, dimensions: EMBEDDING_DIMENSIONS, entries: changed.map((e) => ({ ...e, vector: vectors([e.path])[0] })) },
        readContent: async () => {
          throw new Error("ENOENT: no such file or directory");
        },
        embed: async (texts: string[]) => vectors(texts),
      });
    })(),
    (error: { code?: string; path?: string }) => error.code === "CONTENT_UNAVAILABLE" && error.path === "src/alpha.ts",
  );

  // The attempt is still open and never became the generation the scope serves: the publish
  // transaction rolled its seal, its generation bump and its path rows back together.
  const generation = await db.repoIndexGeneration.findFirstOrThrow({ where: { scopeId: scope.id, attemptId } });
  assert.equal(generation.status, "open", "a refused materialisation leaves the attempt retryable");
  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, 1, "the refused attempt never became the active generation");
  assert.equal(await db.document.count({ where: { contentHash: "digest-alpha-changed" } }), 0, "the refused attempt wrote no document");

  // The previous generation is still live and still searchable: its path row names the same chunk,
  // and that chunk still holds the text and the vector width semantic search reads.
  const after = await anchoredChunks(db, scope.id);
  assert.deepEqual(after.map((row: any) => row.chunkId), before.map((row: any) => row.chunkId), "the old tree keeps its anchor");
  assert.match(after[0].content, /value = 1/, "the old tree's content is still readable");
  assert.equal(after[0].dimensions, EMBEDDING_DIMENSIONS, "the old tree's vector is still the width search reads");
});

// Behaviour: a changed digest replaces that path's chunks instead of accumulating them, so the
// generation's chunks describe the tree it published and not every tree before it.
run("a changed digest replaces the path's chunks", async () => {
  const { db, scope } = await fixture();
  const tree = [{ path: "src/alpha.ts", digest: "digest-old" }];

  await publishGeneration(db, scope, tree, {
    readContent: async () => "export const value = 1;",
    embed: async (texts: string[]) => vectors(texts),
  });
  const before = await anchoredChunks(db, scope.id);

  await publishGeneration(db, scope, [{ path: "src/alpha.ts", digest: "digest-new" }], {
    readContent: async () => "export const value = 2;\nexport const other = 3;",
    embed: async (texts: string[]) => vectors(texts),
  });

  const after = await anchoredChunks(db, scope.id);
  assert.equal(after.length, 1);
  assert.notEqual(after[0].chunkId, before[0].chunkId);
  assert.match(after[0].content, /value = 2/);
});

// Behaviour: a path this tree no longer contains stops being searchable, because recall must never
// return a file the published generation does not have.
run("a path the next tree drops stops being searchable", async () => {
  const { db, project, scope } = await fixture();
  const content = async (path: string) => `export const value = "${path}";`;

  await publishGeneration(db, scope, [
    { path: "src/alpha.ts", digest: "digest-alpha" },
    { path: "src/beta.ts", digest: "digest-beta" },
  ], { readContent: content, embed: async (texts: string[]) => vectors(texts) });

  const published = await publishGeneration(db, scope, [{ path: "src/alpha.ts", digest: "digest-alpha" }], {
    readContent: content,
    embed: async (texts: string[]) => vectors(texts),
    tombstones: ["src/beta.ts"],
  });
  assert.equal(published.code, "PUBLISHED");

  const rows = await anchoredChunks(db, scope.id);
  assert.deepEqual(rows.map((row: any) => row.path), ["src/alpha.ts"]);
  assert.equal(await db.chunk.count({ where: { projectId: project.id, document: { externalId: "src/beta.ts" } } }), 0);
});

const routerPath = "../src/api/repo-index.js";
/** Header that carries the scope grant token; the scope itself is the path parameter. */
const GRANT_HEADER = "X-RetainDB-Repo-Index-Grant";

/**
 * The repository index router mounted the way the server mounts it: behind the middleware that puts
 * the deployment's credential on the context. A finalize posted here is the route's own call, so
 * these tests publish through the HTTP API itself and not through a copy of what it does.
 */
async function scopeApp() {
  const { repoIndexRoutes } = await import(routerPath);
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("/*", async (c, next) => {
    c.set("auth", { orgId: "default", authType: "api_key" } satisfies AuthContext);
    await next();
  });
  app.route("/", repoIndexRoutes);
  return app;
}

type ScopeApp = Awaited<ReturnType<typeof scopeApp>>;

/** A grant token of the one kind the finalize route accepts; the scope owns the row, so it cascades. */
async function adminToken(client: any, scopeId: string): Promise<string> {
  const minted = mintGrantToken();
  await client.repoIndexGrant.create({
    data: { scopeId, kind: "admin", principal: `materialise-test-${scopeId}`, tokenHash: minted.tokenHash },
  });
  return minted.token;
}

/** Posts one finalize to the real route under the given grant, answering its status and body. */
async function finalizeRoute(app: ScopeApp, token: string, scopeId: string, attemptId: string, body: unknown) {
  const response = await app.request(`/v1/repo-index/scopes/${scopeId}/generations/${attemptId}/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json", [GRANT_HEADER]: token },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/**
 * One metadata-only publication through the real finalize route. The attempt and its single part
 * are declared through the store, then the route publishes them with the only body it accepts:
 * paths, digests and vectors, with no content anywhere. `vectorFor` is the embedding stage's answer
 * for a path, so a test can hand the fence a vector semantic search cannot consume.
 */
async function publishMetadata(
  client: any,
  scope: any,
  app: ScopeApp,
  token: string,
  tree: Array<{ path: string; digest: string }>,
  tombstones: string[] = [],
  vectorFor: (path: string) => number[] = (path) => vectors([path])[0],
) {
  const store = await import(storePath);
  const attemptId = randomUUID();
  const current = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  const opened = await store.openAttempt({
    scopeId: scope.id,
    attemptId,
    baseGeneration: current.activeGeneration,
    revision: current.activeGeneration + 1,
    manifestDigest: `digest-${attemptId}`,
    partCount: 1,
  });
  assert.equal(opened.code, "ATTEMPT_OPEN");
  await store.putPart({ scopeId: scope.id, attemptId, partNo: 1, part: { upserts: tree.map((entry) => entry.path), tombstones } });
  return finalizeRoute(app, token, scope.id, attemptId, {
    requiredPaths: tree.map((entry) => entry.path),
    manifest: {
      digest: `digest-${attemptId}`,
      dimensions: EMBEDDING_DIMENSIONS,
      entries: tree.map((entry) => ({ ...entry, vector: vectorFor(entry.path) })),
    },
  });
}

/** The path rows the scope currently serves, in path order. */
async function presentPaths(client: any, scopeId: string) {
  return client.repoIndexPath.findMany({ where: { scopeId, state: "present" }, orderBy: { path: "asc" } });
}

/** The scope's own source row, the one whose counts describe what search can return. */
async function scopeSource(client: any, projectId: string, scopeId: string) {
  return client.source.findFirst({ where: { projectId, name: scopeSourceName(scopeId) } });
}

/**
 * The chunks a semantic search over this scope's source can return, by path: the join is the search
 * surface itself, so a path with no row here cannot be returned by any query.
 */
async function searchableChunks(client: any, scopeId: string) {
  return client.$queryRaw`
    SELECT d."externalId" AS "path", COUNT(c."id")::int AS "chunks"
    FROM "documents" d
    LEFT JOIN "chunks" c ON c."documentId" = d."id"
    WHERE d."sourceId" = (SELECT s."id" FROM "sources" s WHERE s."name" = ${scopeSourceName(scopeId)})
    GROUP BY d."externalId"
    ORDER BY d."externalId"
  `;
}

/** The search surface at its own boundary: every chunk of this scope's source, nearest to `query` first. */
async function nearestPaths(client: any, scopeId: string, query: string) {
  return client.$queryRaw`
    SELECT d."externalId" AS "path"
    FROM "chunks" c
    JOIN "documents" d ON d."id" = c."documentId"
    JOIN "sources" s ON s."id" = d."sourceId"
    WHERE s."name" = ${scopeSourceName(scopeId)}
    ORDER BY c."embedding" <=> ${query}::vector
  `;
}

/** The stored vector of one path's chunk, read as the literal a semantic query would send. */
async function storedVector(client: any, scopeId: string, path: string): Promise<string> {
  const rows = await client.$queryRaw`
    SELECT c."embedding"::text AS "embedding"
    FROM "chunks" c
    JOIN "documents" d ON d."id" = c."documentId"
    JOIN "sources" s ON s."id" = d."sourceId"
    WHERE s."name" = ${scopeSourceName(scopeId)} AND d."externalId" = ${path}
    LIMIT 1
  `;
  assert.equal(rows.length, 1, `${path} has a stored vector before the drop`);
  return rows[0].embedding;
}

/** Publishes the first generation of these tests: a reader, an embedder and one chunk per path. */
async function publishSearchable(db: any, scope: any, tree: Array<{ path: string; digest: string }>) {
  const published = await publishGeneration(db, scope, tree, {
    readContent: async (path: string) => `export const value = "${path}";`,
    embed: async (texts: string[]) => vectors(texts),
  });
  assert.equal(published.code, "PUBLISHED");
  return published;
}

// Behaviour: a publication that carries no content still owes the deletion half of materialisation.
// This route has no reader to embed with, so the tombstone used to be recorded on the path rows
// while the dropped path's chunk stayed in the project: semantic search kept returning a file the
// published generation no longer contains (docs/repo-index.md:358-359).
run("a metadata-only publication that drops a path leaves none of its chunks searchable", async () => {
  const { db, scope } = await fixture();
  await publishSearchable(db, scope, [
    { path: "src/a.ts", digest: "digest-a" },
    { path: "src/b.ts", digest: "digest-b" },
  ]);
  const before = await searchableChunks(db, scope.id);
  assert.deepEqual(
    before.map((row: any) => [row.path, row.chunks]),
    [["src/a.ts", 1], ["src/b.ts", 1]],
    "the first generation is searchable for both paths",
  );
  const droppedVector = await storedVector(db, scope.id, "src/a.ts");

  const token = await adminToken(db, scope.id);
  const metadata = await publishMetadata(
    db,
    scope,
    await scopeApp(),
    token,
    [{ path: "src/b.ts", digest: "digest-b" }],
    ["src/a.ts"],
  );

  assert.equal(metadata.status, 201, `a metadata-only publication is still a publication: ${JSON.stringify(metadata.body)}`);
  assert.equal(metadata.body.code, "PUBLISHED");
  assert.equal(metadata.body.searchable, false, "the route still reports that it materialised no content");
  assert.equal(metadata.body.materialisedChunks, 0, "the drop writes no chunk");

  assert.deepEqual((await presentPaths(db, scope.id)).map((row: any) => row.path), ["src/b.ts"], "the served tree holds the surviving path only");
  assert.deepEqual(
    (await searchableChunks(db, scope.id)).map((row: any) => [row.path, row.chunks]),
    [["src/b.ts", 1]],
    "the dropped path has no chunk left for a search to return",
  );

  // The search surface itself, queried with the dropped chunk's own vector: it is gone, and the
  // surviving path is still a hit.
  const hits = await nearestPaths(db, scope.id, droppedVector);
  assert.deepEqual(hits.map((row: any) => row.path), ["src/b.ts"], "a semantic search cannot return the dropped path");
});

// Behaviour: the drop is exactly the set the manifest stopped naming. Every other path of the
// previous generation keeps its document, its chunks and their vectors, so a publication without
// content cannot erase text it never touched.
run("a metadata-only drop leaves the generation's other paths untouched", async () => {
  const { db, scope } = await fixture();
  await publishSearchable(db, scope, [
    { path: "src/a.ts", digest: "digest-a" },
    { path: "src/b.ts", digest: "digest-b" },
    { path: "src/c.ts", digest: "digest-c" },
  ]);
  const keptChunks = await db.chunk.findMany({
    where: { projectId: scope.projectId, document: { externalId: { in: ["src/b.ts", "src/c.ts"] } } },
    orderBy: { chunkIndex: "asc" },
  });
  assert.equal(keptChunks.length, 2, "the fixture keeps one chunk per surviving path");
  const keptDocuments = await db.document.findMany({
    where: { projectId: scope.projectId, externalId: { in: ["src/b.ts", "src/c.ts"] } },
    orderBy: { externalId: "asc" },
  });

  const token = await adminToken(db, scope.id);
  const metadata = await publishMetadata(
    db,
    scope,
    await scopeApp(),
    token,
    [{ path: "src/b.ts", digest: "digest-b" }, { path: "src/c.ts", digest: "digest-c" }],
    ["src/a.ts"],
  );
  assert.equal(metadata.body.code, "PUBLISHED");

  const keptAfter = await db.chunk.findMany({ where: { id: { in: keptChunks.map((row: any) => row.id) } } });
  assert.deepEqual(
    keptAfter.map((row: any) => [row.id, row.content, row.documentId]).sort(),
    keptChunks.map((row: any) => [row.id, row.content, row.documentId]).sort(),
    "the surviving paths keep the very same chunk rows",
  );
  const documentsAfter = await db.document.findMany({
    where: { id: { in: keptDocuments.map((row: any) => row.id) } },
    orderBy: { externalId: "asc" },
  });
  assert.deepEqual(
    documentsAfter.map((row: any) => [row.id, row.externalId, row.contentHash]),
    keptDocuments.map((row: any) => [row.id, row.externalId, row.contentHash]),
    "the surviving documents are not recreated",
  );
  assert.deepEqual(
    (await searchableChunks(db, scope.id)).map((row: any) => [row.path, row.chunks]),
    [["src/b.ts", 1], ["src/c.ts", 1]],
    "both surviving paths are still searchable",
  );
});

// Behaviour: the drop belongs to the publication, not to the request. A publication the fence
// refuses - here a vector semantic search cannot consume, and a drop the attempt never declared -
// writes nothing at all, so the generation the scope serves keeps every chunk it had. An unsafe
// tree and a stale ref are refused by the connector before the store is asked, and
// repo-index.publish.integration.test.ts pins those against the same invariant.
run("a refused metadata-only publication drops nothing and leaves the last generation searchable", async () => {
  const { db, scope } = await fixture();
  await publishSearchable(db, scope, [
    { path: "src/a.ts", digest: "digest-a" },
    { path: "src/b.ts", digest: "digest-b" },
  ]);
  const before = await searchableChunks(db, scope.id);
  const chunksBefore = await db.chunk.count({ where: { projectId: scope.projectId } });
  const pathsBefore = await presentPaths(db, scope.id);

  const token = await adminToken(db, scope.id);
  const app = await scopeApp();

  // A vector of the wrong width: the fence refuses the manifest (receipt.ts:144 and :148), so the
  // publication that also declares the tombstone never reaches a write.
  const unusable = await publishMetadata(
    db,
    scope,
    app,
    token,
    [{ path: "src/b.ts", digest: "digest-b" }],
    ["src/a.ts"],
    () => Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0.5),
  );
  assert.equal(unusable.status, 422, `a vector of the wrong width is refused: ${JSON.stringify(unusable.body)}`);
  assert.equal(unusable.body.error?.code, "INVALID_MANIFEST");

  // A tree that drops src/a.ts without the attempt declaring it: the same publication is refused.
  const undeclared = await publishMetadata(db, scope, app, token, [{ path: "src/b.ts", digest: "digest-b" }]);
  assert.equal(undeclared.status, 409, `an undeclared drop is refused: ${JSON.stringify(undeclared.body)}`);
  assert.equal(undeclared.body.error?.code, "UNDECLARED_DROP");
  assert.deepEqual(undeclared.body.error?.undeclaredDrops, ["src/a.ts"]);

  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, 1, "no refused publication moved the scope");
  assert.deepEqual(
    (await presentPaths(db, scope.id)).map((row: any) => [row.path, row.generationId, row.state]),
    pathsBefore.map((row: any) => [row.path, row.generationId, row.state]),
    "the served tree is the one that was published",
  );
  assert.deepEqual(
    (await searchableChunks(db, scope.id)).map((row: any) => [row.path, row.chunks]),
    before.map((row: any) => [row.path, row.chunks]),
    "both paths are still searchable",
  );
  assert.equal(await db.chunk.count({ where: { projectId: scope.projectId } }), chunksBefore, "a refused publication wrote no chunk and dropped none");
});

// Behaviour: the scope's source reports what it now holds. A count left behind by a drop describes
// text search no longer has and hides text it does, which is what sources.chunkCount is read for.
run("the scope's source reports the chunk count the drop left", async () => {
  const { db, project, scope } = await fixture();
  await publishSearchable(db, scope, [
    { path: "src/a.ts", digest: "digest-a" },
    { path: "src/b.ts", digest: "digest-b" },
  ]);
  const source = await scopeSource(db, project.id, scope.id);
  assert.equal(source.documentCount, 2, "the first publication recorded the documents it wrote");
  assert.equal(source.chunkCount, 2, "the first publication recorded the chunks it wrote");

  const token = await adminToken(db, scope.id);
  const metadata = await publishMetadata(
    db,
    scope,
    await scopeApp(),
    token,
    [{ path: "src/b.ts", digest: "digest-b" }],
    ["src/a.ts"],
  );
  assert.equal(metadata.body.code, "PUBLISHED");

  const after = await scopeSource(db, project.id, scope.id);
  assert.equal(after.documentCount, 1, "one document is left");
  assert.equal(after.chunkCount, 1, "one chunk is left");
  assert.equal(
    await db.chunk.count({ where: { projectId: project.id, document: { sourceId: source.id } } }),
    1,
    "the recorded count is the row count a search would read",
  );
});

// Behaviour: a scope that was never materialised has nothing to drop, and a metadata-only
// publication does not invent a source row to look for it: the drop half leaves the project's
// source list exactly as it found it.
run("a metadata-only publication of a never-materialised scope creates no source", async () => {
  const { db, project, scope } = await fixture();
  const token = await adminToken(db, scope.id);
  const metadata = await publishMetadata(db, scope, await scopeApp(), token, [{ path: "src/a.ts", digest: "digest-a" }]);
  assert.equal(metadata.status, 201, `a scope with no chunks still publishes its metadata: ${JSON.stringify(metadata.body)}`);
  assert.equal(metadata.body.code, "PUBLISHED");
  assert.equal(await db.source.count({ where: { projectId: project.id } }), 0, "the drop half created no source row");
  assert.equal(await db.document.count({ where: { projectId: project.id } }), 0);
});

after(async () => {
  if (!databaseUrl) return;
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
  if (projectIds.length > 0) await client.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.$disconnect();
  process.env = savedEnvironment;
});
