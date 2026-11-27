/**
 * Committed-ref publication into real PostgreSQL, end to end.
 *
 * The chain this file pins: a real git repository on disk -> the on-disk `RefProvider` ->
 * `readCommittedRef` (pin the ref, enumerate the tree, read every blob) -> `runCommittedRef`
 * (open one attempt, submit its parts, finalize it) -> the real store's publish transaction
 * (fence, generation bump, path rows, chunks) -> rows a semantic search returns, plus a receipt
 * and a manifest that name the same generation.
 *
 * Two seams are supplied by the test; nothing else is replaced, and every write goes through
 * store.ts:
 *
 * - `CommittedRefContext.vectors` is the embedding stage's output: one stable pseudo-vector per
 *   blob digest, computed here, because the publication fence requires a usable 1024-dimension
 *   vector for every manifest path (receipt.ts:144 and :148). No model is called.
 * - `CommittedRefRun.store` is a dependency: this file wraps the real store's own functions and
 *   adds the `embed` option `FinalizeInput` declares, so materialisation embeds chunk text with a
 *   deterministic pseudo-vector per chunk, keyed by that chunk's text, instead of reaching for a
 *   model or an inference service. A replay that reuses a digest calls neither.
 *
 * Not covered here: real model embeddings. The vectors are deterministic stand-ins, so this file
 * proves the publication path, the fence and the stored search surface, not the quality of a model.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { createGitRefProvider } from "../src/connectors/ref-provider-git.js";
import { REF_RUN_OUTCOME, readCommittedRef, type RefProvider } from "../src/connectors/repo-ref.js";
import { RUN_CODE, runCommittedRef, type CommittedRefRunResult, type PublicationStore } from "../src/engine/repo-index/connector-run.js";
import { mintGrantToken } from "../src/engine/repo-index/grant-token.js";
import { scopeSourceName, type Embedder } from "../src/engine/repo-index/materialise.js";
import { EMBEDDING_DIMENSIONS } from "../src/engine/repo-index/receipt.js";
import type { FinalizeInput } from "../src/engine/repo-index/store.js";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("RETAINDB_TEST_DATABASE_URL must name a migrated PostgreSQL database: this file publishes real generations and skips nothing");
}
process.env.DATABASE_URL = databaseUrl;
const savedEnvironment = { ...process.env };

/** Bounded so a runaway git answer fails loudly instead of growing without limit. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Every fixture repository and every scope row this file created, removed once the suite finishes. */
const fixtureRepos: string[] = [];
const scopeIds: string[] = [];
const projectIds: string[] = [];

/** Runs git in one fixture repository and answers its stdout as text. */
function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed in ${repo}: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Writes one file of a fixture repository, creating its parent directories. */
async function write(repo: string, path: string, content: string): Promise<void> {
  const full = join(repo, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

/** Stages everything and commits it, answering the full sha of the new commit. */
async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

interface RepoFixture {
  /** The real repository on disk; removed by the after hook. */
  repoDir: string;
  /** The commit before the published one, so a branch can be moved back to it. */
  earlier: string;
  /** The published tree: README.md, src/alpha.ts, src/beta.ts, src/gamma.ts. */
  main: string;
  /** A tree holding a symlink, which the connector refuses as unsafe. */
  unsafe: string;
}

/**
 * A real repository with a local identity, three branches and no network: `main` holds the tree
 * this file publishes, `earlier` is the commit a branch is moved back to, and `unsafe` adds a
 * symlink that leaves the tree root. Built once per file because nothing after setup writes to it,
 * and outside the project tree.
 */
async function fixtureRepo(): Promise<RepoFixture> {
  const repoDir = await mkdtemp(join(tmpdir(), "repo-index-publish-"));
  fixtureRepos.push(repoDir);
  await git(repoDir, ["init", "-q", "-b", "main", "."]);
  await git(repoDir, ["config", "user.email", "repo-index-publish@example.invalid"]);
  await git(repoDir, ["config", "user.name", "Repo Index Publish Test"]);
  await write(repoDir, "README.md", "# Fixture repository\n\nA repository the publication run reads.\n");
  await write(repoDir, "src/alpha.ts", "export const alpha = 1;\n");
  await write(repoDir, "src/beta.ts", "export const beta = () => alpha + 1;\n");
  const earlier = await commitAll(repoDir, "the first tree");
  await write(repoDir, "src/gamma.ts", "export const gamma = () => beta() * 2;\n");
  const main = await commitAll(repoDir, "the published tree");
  await git(repoDir, ["checkout", "-q", "-b", "unsafe"]);
  await mkdir(join(repoDir, "docs"), { recursive: true });
  await symlink("../README.md", join(repoDir, "docs/link.md"));
  const unsafe = await commitAll(repoDir, "a symlink leaves the tree root");
  await git(repoDir, ["checkout", "-q", "main"]);
  return { repoDir, earlier, main, unsafe };
}

let repoFixture: Promise<RepoFixture> | undefined;

/** The one fixture repository of this file, created on first use. */
function sharedRepo(): Promise<RepoFixture> {
  repoFixture ??= fixtureRepo();
  return repoFixture;
}

/**
 * A stable 1024-dimension vector derived from a seed: the width chunks.embedding stores, every
 * element finite and inside [-1, 1], and no element ever exactly zero. It stands in for a model
 * embedding, so a run repeated over the same seed produces the same vector and nothing calls out.
 */
function pseudoVector(seed: string): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < EMBEDDING_DIMENSIONS; block++) {
    const bytes = createHash("sha256").update(`${seed}:${block}`, "utf8").digest();
    for (const byte of bytes) {
      if (vector.length === EMBEDDING_DIMENSIONS) break;
      // byte/255*2-1 is zero only for byte 127.5, so every element is non-zero.
      vector.push((byte / 255) * 2 - 1);
    }
  }
  return vector;
}

/** The embedding stage, replaced by a deterministic pseudo-vector per chunk text. */
function deterministicEmbedder(seen: string[] = []): Embedder {
  return async (texts: string[]) => {
    seen.push(...texts);
    return texts.map((text) => pseudoVector(`chunk:${text}`));
  };
}

/**
 * The real store, entry for entry. It is the dependency `runCommittedRef` takes, so this is where
 * a caller supplies the options the run does not carry; every function below is store.ts's own.
 * `finalizeAttempt` is that seam: store.ts's `FinalizeInput.embed` is the one option
 * materialisation takes its vectors from, and connector-run.ts does not pass it.
 */
async function realStore(embed: Embedder = deterministicEmbedder()): Promise<PublicationStore> {
  const store = await import("../src/engine/repo-index/store.js");
  return {
    openAttempt: store.openAttempt,
    putPart: store.putPart,
    abandonAttempt: store.abandonAttempt,
    readManifest: store.readManifest,
    finalizeAttempt: (input: FinalizeInput) => store.finalizeAttempt({ ...input, embed }),
  };
}

/** One active scope with its own project and the connector grant a sync worker would hold. */
async function fixtureScope() {
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  const name = `repo-index-publish-${randomUUID()}`;
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
  const grant = await client.repoIndexGrant.create({
    data: { scopeId: scope.id, kind: "connector", principal: `sync-${name}`, tokenHash: mintGrantToken().tokenHash },
  });
  return { db: client, project, scope, grant };
}

/**
 * The connector's own read of one ref: the commit it pins, the manifest of that commit's tree, and
 * one stable vector per blob digest. This is the caller's half of a run, so the vectors the fence
 * is given are derived from the same digests the run will read.
 */
async function treeAt(repoDir: string, ref: string) {
  const read = await readCommittedRef(createGitRefProvider({ repoDir }), { ref });
  assert.equal(read.outcome, REF_RUN_OUTCOME.COMPLETE, `the fixture ref ${ref} must read cleanly: ${read.failure}`);
  return {
    commit: read.commit,
    entries: read.manifest,
    vectors: new Map(read.manifest.map((entry) => [entry.path, pseudoVector(entry.digest)] as const)),
  };
}

interface RunOptions {
  repoDir: string;
  scopeId: string;
  /** The vectors the embedding stage produced for this tree. */
  vectors: ReadonlyMap<string, number[]>;
  ref?: string;
  attemptId?: string;
  baseGeneration?: number;
  revision?: number;
  /** A provider that answers for this run; defaults to the on-disk git adapter. */
  provider?: RefProvider;
  /** The embedder materialisation uses; defaults to the deterministic one, never a provider. */
  embed?: Embedder;
}

/** One committed-ref run against one real scope, publishing through the real store. */
async function committedRefRun(options: RunOptions): Promise<{ result: CommittedRefRunResult; attemptId: string }> {
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  const scope = await client.repoIndexScope.findUniqueOrThrow({ where: { id: options.scopeId } });
  const attemptId = options.attemptId ?? randomUUID();
  const result = await runCommittedRef({
    provider: options.provider ?? createGitRefProvider({ repoDir: options.repoDir }),
    request: { ref: options.ref ?? "refs/heads/main" },
    context: {
      scopeId: options.scopeId,
      attemptId,
      // The fence compares this against the scope at publish time, so it is the generation the
      // caller observed; both default to the scope's own current values.
      baseGeneration: options.baseGeneration ?? scope.activeGeneration,
      revision: options.revision ?? scope.activeGeneration + 1,
      vectors: options.vectors,
    },
    store: await realStore(options.embed),
  });
  return { result, attemptId };
}

/** The path rows the scope currently serves, in path order. */
async function servedPaths(client: any, scopeId: string) {
  return client.repoIndexPath.findMany({ where: { scopeId, state: "present" }, orderBy: { path: "asc" } });
}

/** The generation rows of one scope, newest first. */
async function generationsOf(client: any, scopeId: string) {
  return client.repoIndexGeneration.findMany({ where: { scopeId }, orderBy: { generation: "asc" } });
}

// Behaviour: one committed-ref run over a real repository publishes exactly one generation, moves
// the scope onto it, and writes one path row per declared path with the digest of the blob the run
// read from that commit.
test("a committed-ref run publishes one generation and moves the scope onto it", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");

  const { result, attemptId } = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });

  assert.equal(result.code, RUN_CODE.PUBLISHED, "the store published the complete read");
  assert.equal(result.layer, null, "nothing refused, so no layer names a refusal");
  assert.equal(result.commit, tree.commit, "the publication is attributed to the commit the ref pinned");
  assert.equal(result.partCount, 1, "four paths fit in one part");
  assert.equal(result.generation, 1);
  assert.equal(typeof result.receiptDigest, "string");

  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, 1, "the scope now serves the generation the run published");

  const generations = await generationsOf(db, scope.id);
  assert.equal(generations.length, 1, "one run leaves one generation row");
  assert.equal(generations[0].status, "published");
  assert.equal(generations[0].generation, 1);
  assert.equal(generations[0].id, result.generationId);
  assert.equal(generations[0].attemptId, attemptId);
  assert.equal(generations[0].receiptDigest, result.receiptDigest);
  assert.equal(generations[0].manifestDigest.length, 64, "the declared digest is the run's own sha256");
  assert.ok(generations[0].publishedAt instanceof Date);

  const paths = await servedPaths(db, scope.id);
  assert.deepEqual(paths.map((row: any) => row.path), tree.entries.map((entry) => entry.path));
  for (const [index, row] of paths.entries()) {
    assert.equal(row.state, "present");
    assert.equal(row.generationId, result.generationId, `${row.path} belongs to the published generation`);
    assert.equal(row.digest, tree.entries[index].digest, `${row.path} carries the digest of the blob at ${tree.commit}`);
    assert.ok(row.chunkId, `${row.path} names the chunk search returns`);
  }

  const parts = await db.repoIndexPart.findMany({ where: { generationId: result.generationId } });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].partNo, 1);
  assert.equal(parts[0].upsertCount, tree.entries.length);
  assert.equal(parts[0].tombstoneCount, 0);
});

// Behaviour: the published generation is searchable in PostgreSQL itself. Each path's anchor is a
// 1024-dimension vector with a non-zero norm, and a real cosine-distance query over the scope's
// chunks returns that chunk as the nearest hit, resolving to the path row the run published.
test("a published path is returned by a semantic search over its stored vector", async () => {
  const repo = await sharedRepo();
  const { db, project, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");
  const { result } = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(result.code, RUN_CODE.PUBLISHED);

  const anchors = await db.$queryRaw`
    SELECT p."path" AS "path", p."generationId" AS "generationId", c."id" AS "chunkId",
           c."content" AS "content", c."embedding"::text AS "embedding",
           vector_dims(c."embedding") AS "dimensions", vector_norm(c."embedding") AS "norm"
    FROM "repo_index_paths" p
    JOIN "chunks" c ON c."id" = p."chunkId"
    WHERE p."scopeId" = ${scope.id} AND p."state" = 'present'
    ORDER BY p."path"
  `;
  assert.deepEqual(anchors.map((row: any) => row.path), tree.entries.map((entry) => entry.path), "every declared path anchors a chunk");
  for (const row of anchors) {
    assert.equal(row.dimensions, EMBEDDING_DIMENSIONS, "a chunk search cannot read would be a row nothing returns");
    assert.ok(Number(row.norm) > 0, "an all-zero vector makes cosine distance NaN in pgvector");
    assert.equal(row.generationId, result.generationId);
  }

  // The stored vectors are the deterministic ones this file supplied: the injected embedder is the
  // only writer, so nothing here came from a model. float4 storage rounds, hence the tolerance.
  for (const row of anchors) {
    const expected = pseudoVector(`chunk:${row.content}`);
    const stored = String(row.embedding).slice(1, -1).split(",").map(Number);
    assert.equal(stored.length, EMBEDDING_DIMENSIONS);
    const largest = Math.max(...stored.map((value, index) => Math.abs(value - expected[index])));
    assert.ok(largest < 1e-6, `${row.path} holds the vector the injected embedder produced`);
  }

  // A real semantic query: the query vector is the one derived from a chunk's own text, so that
  // chunk is the nearest neighbour and the hit has to resolve to its published path row. Index
  // scans are off for this read because the alternative plan - an HNSW index scan - is approximate
  // by construction: it answers from its candidate window in distance order and never sees the
  // joins above it (pgvector 0.8.7 keeps walking the graph only when the filter is on the indexed
  // table and `hnsw.iterative_scan` is set), so a chunk that exists can fall outside the window.
  // The assertion is about which path the query resolves to, so the ordering has to be exact.
  const target = anchors[anchors.length - 1];
  const query = `[${pseudoVector(`chunk:${target.content}`).join(",")}]`;
  const hits = await db.$transaction(async (tx: any) => {
    await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
    return tx.$queryRaw`
      SELECT c."id" AS "chunkId", d."externalId" AS "path", d."projectId" AS "projectId",
             s."type" AS "sourceType", s."name" AS "sourceName", p."path" AS "publishedPath",
             p."generationId" AS "generationId", (1 - (c."embedding" <=> ${query}::vector)) AS "score"
      FROM "chunks" c
      JOIN "documents" d ON d."id" = c."documentId"
      JOIN "sources" s ON s."id" = d."sourceId"
      JOIN "repo_index_paths" p ON p."chunkId" = c."id"
      WHERE s."projectId" = ${project.id} AND p."scopeId" = ${scope.id}
      ORDER BY c."embedding" <=> ${query}::vector
      LIMIT 1
    `;
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunkId, target.chunkId, "the nearest hit is the chunk whose vector was the query");
  assert.equal(hits[0].publishedPath, hits[0].path, "the hit resolves to the path row that published it");
  assert.equal(hits[0].generationId, result.generationId, "the hit belongs to the published generation");
  assert.equal(hits[0].projectId, project.id);
  assert.equal(hits[0].sourceType, "repo_index");
  assert.equal(hits[0].sourceName, scopeSourceName(scope.id));
  assert.ok(Number(hits[0].score) > 0.999999, "an identical vector is its own nearest neighbour");
});

// Behaviour: the publication is attributable afterwards. The receipt and the manifest are read back
// through the store's own readers and both name the generation the run published, path by path.
test("the receipt and the manifest name the generation the run published", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");
  const { result, attemptId } = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(result.code, RUN_CODE.PUBLISHED);

  const { readReceipt, readManifest } = await import("../src/engine/repo-index/store.js");
  const receipt = await readReceipt({ scopeId: scope.id, attemptId });
  assert.equal(receipt.code, "OK");
  assert.equal(receipt.receipt?.generation, result.generation, "the receipt names the published generation");
  assert.equal(receipt.receipt?.attemptId, attemptId);
  assert.equal(receipt.receipt?.receiptDigest, result.receiptDigest);
  assert.equal(receipt.receipt?.revision, 1);
  assert.equal(receipt.receipt?.scopeId, scope.id);
  const generation = await db.repoIndexGeneration.findUniqueOrThrow({ where: { id: result.generationId } });
  assert.equal(receipt.receipt?.manifestDigest, generation.manifestDigest, "the receipt names the tree that was published");

  const manifest = await readManifest({ scopeId: scope.id });
  assert.equal(manifest.code, "OK");
  assert.equal(manifest.generation, result.generation);
  assert.equal(manifest.nextCursor, null, "four paths fit in one page");
  assert.deepEqual(
    manifest.entries?.map((entry) => ({ path: entry.path, digest: entry.digest })),
    tree.entries.map((entry) => ({ path: entry.path, digest: entry.digest })),
    "the manifest returns the tree the run read, digest for digest",
  );
  assert.ok(manifest.entries?.every((entry) => typeof entry.chunkId === "string" && entry.chunkId.length > 0), "every manifest path is searchable");

  // Reading the newest publication without naming an attempt answers the same generation.
  const newest = await readReceipt({ scopeId: scope.id });
  assert.equal(newest.code, "OK");
  assert.equal(newest.receipt?.generation, result.generation);
});

// Behaviour: replaying the same attempt over the same commit is the same publication. The store
// answers the attempt it already holds, no second generation appears, and nothing is re-embedded.
test("replaying the same attempt over the same commit reuses its generation", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");

  const first = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(first.result.code, RUN_CODE.PUBLISHED);
  const before = await servedPaths(db, scope.id);
  const chunksBefore = await db.chunk.count({ where: { projectId: scope.projectId } });

  // The same declaration, replayed: same attempt, same base generation, same revision, same tree.
  const embedded: string[] = [];
  const replay = await committedRefRun({
    repoDir: repo.repoDir,
    scopeId: scope.id,
    vectors: tree.vectors,
    attemptId: first.attemptId,
    baseGeneration: 0,
    revision: 1,
    embed: deterministicEmbedder(embedded),
  });

  assert.equal(replay.result.code, RUN_CODE.PUBLISHED, "a replay answers the publication it already made");
  assert.equal(replay.result.generation, first.result.generation);
  assert.equal(replay.result.generationId, first.result.generationId);
  assert.equal(replay.result.receiptDigest, first.result.receiptDigest);
  assert.deepEqual(embedded, [], "a replay embeds nothing at all");

  const generations = await generationsOf(db, scope.id);
  assert.equal(generations.length, 1, "a replay adds no generation row");
  assert.equal(generations.filter((row: any) => row.status === "published").length, 1);
  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, first.result.generation);

  const after = await servedPaths(db, scope.id);
  assert.deepEqual(after.map((row: any) => [row.path, row.chunkId]), before.map((row: any) => [row.path, row.chunkId]), "a replay keeps the same anchors");
  assert.ok(after.every((row: any) => row.generationId === first.result.generationId));
  assert.equal(await db.chunk.count({ where: { projectId: scope.projectId } }), chunksBefore, "a replay writes no chunk");
});

// Behaviour: a retry that declares a different revision under the same attempt id is a conflict,
// not a second publication. Nothing is published and the scope keeps serving its generation.
test("the same attempt id with a changed declaration is refused as a conflict", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");
  const first = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(first.result.code, RUN_CODE.PUBLISHED);

  const conflicting = await committedRefRun({
    repoDir: repo.repoDir,
    scopeId: scope.id,
    vectors: tree.vectors,
    attemptId: first.attemptId,
    baseGeneration: 0,
    revision: 2,
  });

  assert.equal(conflicting.result.code, RUN_CODE.STORE_REFUSED);
  assert.equal(conflicting.result.layer, "store");
  assert.equal(conflicting.result.storeCode, "ATTEMPT_CONFLICT", "the attempt already holds another declaration");
  assert.equal(conflicting.result.partCount, 0, "no part was submitted for the changed declaration");
  assert.equal(conflicting.result.abandoned, false, "the run opened no attempt, so it abandoned none");

  const generations = await generationsOf(db, scope.id);
  assert.equal(generations.length, 1, "a conflict adds no generation row");
  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, first.result.generation);
  const paths = await servedPaths(db, scope.id);
  assert.ok(paths.every((row: any) => row.generationId === first.result.generationId));
});

// Behaviour: a second run from the same commit, declared as a new attempt, supersedes the first.
// The scope serves the new generation, every present path belongs to it, the earlier publication
// stays readable as history, and the unchanged tree is reused instead of re-embedded.
test("a second attempt over the same commit supersedes the first without corrupting it", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");
  const first = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(first.result.code, RUN_CODE.PUBLISHED);
  const firstAnchors = await servedPaths(db, scope.id);

  const embedded: string[] = [];
  const second = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors, embed: deterministicEmbedder(embedded) });

  assert.equal(second.result.code, RUN_CODE.PUBLISHED);
  assert.equal(second.result.generation, 2, "a new attempt publishes the next generation");
  assert.notEqual(second.result.generationId, first.result.generationId);
  assert.deepEqual(embedded, [], "an unchanged tree is reused, never embedded again");

  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, 2, "the scope serves the new generation");

  // The invariant: exactly one published generation is the one the scope serves, and every present
  // path row belongs to it. The earlier row keeps its published status as history, which is why the
  // count is asserted against the active generation rather than against the whole table.
  const generations = await generationsOf(db, scope.id);
  assert.equal(generations.length, 2);
  const serving = generations.filter((row: any) => row.status === "published" && row.generation === scopeAfter.activeGeneration);
  assert.equal(serving.length, 1, "exactly one published generation is the one the scope serves");
  const paths = await servedPaths(db, scope.id);
  assert.equal(paths.length, tree.entries.length);
  assert.ok(paths.every((row: any) => row.generationId === second.result.generationId), "every present path belongs to the served generation");
  assert.deepEqual(paths.map((row: any) => row.chunkId), firstAnchors.map((row: any) => row.chunkId), "the served paths keep their anchors");

  const { readManifest, readReceipt } = await import("../src/engine/repo-index/store.js");
  const manifest = await readManifest({ scopeId: scope.id });
  assert.equal(manifest.code, "OK");
  assert.equal(manifest.generation, 2);
  assert.deepEqual(manifest.entries?.map((entry) => entry.path), tree.entries.map((entry) => entry.path));

  const newest = await readReceipt({ scopeId: scope.id });
  assert.equal(newest.receipt?.generation, 2, "the newest receipt names the generation now served");
  const historical = await readReceipt({ scopeId: scope.id, attemptId: first.attemptId });
  assert.equal(historical.receipt?.generation, 1, "the superseded publication keeps its own receipt");
});

/**
 * The real on-disk adapter, with the branch moved under a running run: an upstream push that lands
 * between the connector's pin and its freshness re-check. Every answer still come from git.
 */
function movedRefProvider(repoDir: string, branch: string, to: string): RefProvider {
  const real = createGitRefProvider({ repoDir });
  let resolutions = 0;
  return {
    async resolveRef(ref: string) {
      resolutions += 1;
      // The connector resolves once to pin and once to confirm; the push lands between them.
      if (resolutions === 2) await git(repoDir, ["branch", "-f", branch, to]);
      return real.resolveRef(ref);
    },
    listTree: (commit, page) => real.listTree(commit, page),
    readBlob: (commit, path) => real.readBlob(commit, path),
  };
}

// Behaviour: a run whose ref moved publishes nothing at all. The scope keeps serving the generation
// it had, its path rows are untouched, and both the receipt and the manifest still read it.
test("a run whose ref moved publishes nothing and leaves the last good generation live", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  // A branch of its own, so this case can move it without disturbing any other.
  await git(repo.repoDir, ["branch", "-f", "release", repo.main]);
  const tree = await treeAt(repo.repoDir, "refs/heads/release");
  const published = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, ref: "refs/heads/release", vectors: tree.vectors });
  assert.equal(published.result.code, RUN_CODE.PUBLISHED);
  const before = await servedPaths(db, scope.id);
  const chunksBefore = await db.chunk.count({ where: { projectId: scope.projectId } });

  const moved = await committedRefRun({
    repoDir: repo.repoDir,
    scopeId: scope.id,
    ref: "refs/heads/release",
    vectors: tree.vectors,
    provider: movedRefProvider(repo.repoDir, "release", repo.earlier),
  });

  assert.equal(moved.result.code, RUN_CODE.STALE_REF, "the connector saw the branch move and refused the tree");
  assert.equal(moved.result.layer, "connector");
  assert.equal(moved.result.commit, tree.commit, "the refusal names the commit that was pinned");
  assert.equal(moved.result.partCount, 0, "no attempt was opened for a stale ref");
  assert.equal(moved.result.abandoned, false);
  assert.equal(moved.result.generationId, undefined);
  assert.equal(moved.result.storeCode, null, "the store was never asked");
  assert.deepEqual(moved.result.violations, []);
  assert.equal((await git(repo.repoDir, ["rev-parse", "release"])).trim(), repo.earlier, "the branch really moved");

  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, published.result.generation, "the scope still serves the last good generation");
  assert.equal((await generationsOf(db, scope.id)).length, 1, "a refused run creates no generation row");
  const after = await servedPaths(db, scope.id);
  assert.deepEqual(after.map((row: any) => [row.path, row.chunkId]), before.map((row: any) => [row.path, row.chunkId]));
  assert.ok(after.every((row: any) => row.generationId === published.result.generationId));
  assert.equal(await db.chunk.count({ where: { projectId: scope.projectId } }), chunksBefore, "no chunk was written");

  const { readManifest, readReceipt } = await import("../src/engine/repo-index/store.js");
  const manifest = await readManifest({ scopeId: scope.id });
  assert.equal(manifest.code, "OK");
  assert.equal(manifest.generation, published.result.generation);
  assert.deepEqual(manifest.entries?.map((entry) => entry.path), tree.entries.map((entry) => entry.path), "the last good tree is still readable");
  const receipt = await readReceipt({ scopeId: scope.id });
  assert.equal(receipt.code, "OK");
  assert.equal(receipt.receipt?.generation, published.result.generation);
});

// Behaviour: a tree holding a symlink is refused as unsafe, so the run publishes nothing and the
// generation the scope already serves keeps its paths and its searchable chunks.
test("a tree with an unsafe entry publishes nothing and leaves the last good generation live", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");
  const published = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(published.result.code, RUN_CODE.PUBLISHED);
  const before = await servedPaths(db, scope.id);

  const unsafe = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, ref: "refs/heads/unsafe", vectors: new Map() });

  assert.equal(unsafe.result.code, RUN_CODE.UNSAFE_TREE);
  assert.equal(unsafe.result.layer, "connector");
  assert.equal(unsafe.result.commit, repo.unsafe);
  assert.deepEqual(unsafe.result.violations, [{ path: "docs/link.md", reason: "SYMLINK" }], "the refusal names the entry that leaves the root");
  assert.equal(unsafe.result.partCount, 0);
  assert.equal(unsafe.result.abandoned, false);
  assert.equal(unsafe.result.generationId, undefined);

  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, published.result.generation);
  assert.equal((await generationsOf(db, scope.id)).length, 1);
  assert.deepEqual((await servedPaths(db, scope.id)).map((row: any) => [row.path, row.chunkId]), before.map((row: any) => [row.path, row.chunkId]));

  const { readManifest } = await import("../src/engine/repo-index/store.js");
  const manifest = await readManifest({ scopeId: scope.id });
  assert.equal(manifest.code, "OK");
  assert.deepEqual(manifest.entries?.map((entry) => entry.path), tree.entries.map((entry) => entry.path));
});

// Behaviour: publication requires a vector for every manifest path. A path the embedding stage
// never answered for refuses the run before a single attempt is opened, so the scope is untouched.
test("a manifest path without a vector refuses the run and publishes nothing", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");
  const published = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(published.result.code, RUN_CODE.PUBLISHED);
  const before = await servedPaths(db, scope.id);

  const vectors = new Map(tree.vectors);
  vectors.delete("src/gamma.ts");
  const refused = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors });

  assert.equal(refused.result.code, RUN_CODE.MISSING_EMBEDDING);
  assert.equal(refused.result.layer, "input", "the caller's vectors are what is missing");
  assert.match(refused.result.failure ?? "", /src\/gamma\.ts/);
  assert.equal(refused.result.partCount, 0, "the run refused before opening an attempt");
  assert.equal(refused.result.abandoned, false);
  assert.equal(refused.result.generationId, undefined);

  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, published.result.generation);
  assert.equal((await generationsOf(db, scope.id)).length, 1);
  assert.deepEqual((await servedPaths(db, scope.id)).map((row: any) => [row.path, row.chunkId]), before.map((row: any) => [row.path, row.chunkId]));
});

// Behaviour: a vector semantic search cannot consume refuses the run as well. The width the store
// expects (receipt.ts:144), an all-zero vector, a NaN element and a hole (receipt.ts:148) are all
// refused, and none of them publishes anything.
test("a vector search cannot consume refuses the run and publishes nothing", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");
  const published = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(published.result.code, RUN_CODE.PUBLISHED);
  const before = await servedPaths(db, scope.id);

  const tooNarrow = Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0.5);
  const allZero = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const withNaN = pseudoVector("nan");
  withNaN[7] = Number.NaN;
  const withHole = pseudoVector("hole");
  delete withHole[9];
  assert.equal(9 in withHole, false, "the fixture really has a hole, which every/some would skip");

  for (const [shape, vector] of [
    ["one dimension short", tooNarrow],
    ["every element zero", allZero],
    ["a NaN element", withNaN],
    ["a hole", withHole],
  ] as const) {
    const vectors = new Map(tree.vectors);
    vectors.set("src/alpha.ts", vector);
    const refused = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors });

    assert.equal(refused.result.code, RUN_CODE.MISSING_EMBEDDING, `${shape} refuses the run`);
    assert.equal(refused.result.layer, "input", `${shape} is the caller's vector`);
    assert.match(refused.result.failure ?? "", /src\/alpha\.ts/, `${shape} names the path`);
    assert.equal(refused.result.partCount, 0, `${shape} opens no attempt`);
  }

  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, published.result.generation, "no refused shape replaced the published generation");
  assert.equal((await generationsOf(db, scope.id)).length, 1);
  assert.deepEqual((await servedPaths(db, scope.id)).map((row: any) => [row.path, row.chunkId]), before.map((row: any) => [row.path, row.chunkId]));
});

// Behaviour: a scope paused between the upload and the seal is a refusal about the scope, not a
// broken store. The run must answer with the scope's own code (STORE_REFUSED carrying SCOPE_PAUSED)
// instead of STORE_FAILED, which blames the database for an operator's pause; and the tree the scope
// served before stays exactly as it was.
test("a pause during a publication is a scope refusal, not a store failure", async () => {
  const repo = await sharedRepo();
  const { db, scope } = await fixtureScope();
  const tree = await treeAt(repo.repoDir, "refs/heads/main");
  const published = await committedRefRun({ repoDir: repo.repoDir, scopeId: scope.id, vectors: tree.vectors });
  assert.equal(published.result.code, RUN_CODE.PUBLISHED, "the fixture scope serves a generation");
  const served = await servedPaths(db, scope.id);

  // The pause lands after every part is accepted and before the seal, which is the window an
  // operator's pause actually hits. The store is the real one; only the accepted part is observed.
  const store = await realStore();
  const pausing = {
    ...store,
    putPart: async (input: Parameters<PublicationStore["putPart"]>[0]) => {
      const answer = await store.putPart(input);
      await db.repoIndexScope.update({ where: { id: scope.id }, data: { state: "paused" } });
      return answer;
    },
  };
  const { PROMOTION_OUTCOME } = await import("../src/engine/repo-index/receipt.js");
  const refused = await runCommittedRef({
    provider: createGitRefProvider({ repoDir: repo.repoDir }),
    request: { ref: "refs/heads/main" },
    context: {
      scopeId: scope.id,
      attemptId: randomUUID(),
      baseGeneration: published.result.generation as number,
      revision: (published.result.generation as number) + 1,
      vectors: tree.vectors,
    },
    store: pausing,
  });

  assert.notEqual(refused.code, RUN_CODE.STORE_FAILED, `a pause is not a store failure: ${refused.failure}`);
  assert.equal(refused.code, RUN_CODE.STORE_REFUSED, `the run refuses on the store's answer: ${JSON.stringify(refused)}`);
  assert.equal(refused.storeCode, PROMOTION_OUTCOME.SCOPE_PAUSED, "and the code is the scope's own");
  assert.equal(refused.failure, null, "a refusal is not a failure with a message");

  const scopeAfter = await db.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, published.result.generation, "nothing was published into a paused scope");
  assert.equal(scopeAfter.state, "paused", "and the run did not resume it");
  assert.deepEqual((await servedPaths(db, scope.id)).map((row: any) => [row.path, row.chunkId]), served.map((row: any) => [row.path, row.chunkId]));
  assert.equal(
    await db.document.count({ where: { projectId: scope.projectId, deletedAt: { not: null } } }),
    0,
    "and the pause left no staged row behind",
  );
});

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
  if (!databaseUrl) return;
  const { db } = await import("../src/db/index.js");
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
    await Promise.all(fixtureRepos.map((repo) => rm(repo, { recursive: true, force: true })));
    await client.$disconnect();
    process.env = savedEnvironment;
  }
});
