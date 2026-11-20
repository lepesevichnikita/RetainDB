/**
 * A publication is staged before it is promoted, and the two halves are observed from outside.
 *
 * The transaction that publishes a generation used to carry the whole materialisation - every blob
 * read, every chunk embedded, every chunk row inserted - which is what made a real tree outrun its
 * 30s budget. Staging moved that work out, and this file pins what the move must not have changed:
 *
 * - a stage is invisible. Between `stageAttempt` and `finalizeAttempt` the scope still serves the
 *   generation it served before, a search returns that generation's text and nothing from the
 *   stage, and the path rows have not moved;
 * - the promotion is what makes the stage visible, in one commit, along with the path rows that
 *   name it;
 * - a stage that never promotes - because the fence refused it, or because the attempt was
 *   abandoned - leaves the last good generation searchable and leaves no row behind.
 *
 * The searches go through `engine/retriever.ts` `retrieve`, the call POST /v1/context/query makes,
 * with its lexical half only (`useVector: false`): the published chunk text holds the token and the
 * staged chunk text does not, so "what a reader can find" is the assertion. Chunk vectors are a
 * deterministic pseudo-vector, so no model is called and the measurement is the database's.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("RETAINDB_TEST_DATABASE_URL must name a migrated PostgreSQL database: this file publishes real generations and skips nothing");
}
process.env.DATABASE_URL = databaseUrl;
const savedEnvironment = { ...process.env };

const storePath = "../src/engine/repo-index/store.js";
const receiptPath = "../src/engine/repo-index/receipt.js";
const retrieverPath = "../src/engine/retriever.js";

/** Every scope and project this file created, removed and counted in `after`. */
const scopeIds: string[] = [];
const projectIds: string[] = [];

/**
 * A stable vector of the width the fence requires, derived from a seed: every element finite, inside
 * [-1, 1] and never exactly zero. It stands in for a model embedding so no provider is called.
 */
function pseudoVector(seed: string, dimensions: number): number[] {
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

/** The embedder the fixture publications use: one pseudo-vector per chunk text. */
function embedder(dimensions: number) {
  return async (texts: string[]) => texts.map((text) => pseudoVector(`chunk:${text}`, dimensions));
}

/** One file of a fixture tree: its path and the text a search has to tell apart. */
interface TreeFile {
  path: string;
  content: string;
}

/** One project and one active repository scope inside it, both removed in `after`. */
async function fixture() {
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  const name = `staging-${randomUUID()}`;
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

/** The manifest of one fixture tree: the digest the fence compares and a vector per path. */
async function manifestOf(tree: readonly TreeFile[], attemptId: string) {
  const { EMBEDDING_DIMENSIONS } = await import(receiptPath);
  return {
    digest: `digest-${attemptId}`,
    dimensions: EMBEDDING_DIMENSIONS,
    entries: tree.map((file) => ({
      path: file.path,
      digest: createHash("sha256").update(file.content, "utf8").digest("hex"),
      vector: pseudoVector(`fence:${file.path}`, EMBEDDING_DIMENSIONS),
    })),
  };
}

/**
 * Declares one attempt for one tree: opens it against the generation the scope serves now, and
 * stores the single part that names every path it upserts. Nothing is published yet.
 */
async function declare(client: any, scope: any, tree: readonly TreeFile[], options: { baseGeneration?: number } = {}) {
  const store = await import(storePath);
  const { EMBEDDING_DIMENSIONS } = await import(receiptPath);
  const attemptId = randomUUID();
  const current = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  const baseGeneration = options.baseGeneration ?? current.activeGeneration;
  const manifest = await manifestOf(tree, attemptId);
  const opened = await store.openAttempt({
    scopeId: scope.id,
    attemptId,
    baseGeneration,
    revision: baseGeneration + 1,
    manifestDigest: manifest.digest,
    partCount: 1,
  });
  assert.equal(opened.code, "ATTEMPT_OPEN", `the attempt opens against generation ${baseGeneration}: ${opened.code}`);
  const part = await store.putPart({
    scopeId: scope.id,
    attemptId,
    partNo: 1,
    part: { upserts: tree.map((file) => file.path), tombstones: [] },
  });
  assert.equal(part.code, "PART_ACCEPTED", `the one part is accepted: ${part.code}`);
  const byPath = new Map(tree.map((file) => [file.path, file.content] as const));
  return {
    attemptId,
    manifest,
    requiredPaths: tree.map((file) => file.path),
    readContent: async (path: string) => byPath.get(path) as string,
    embed: embedder(EMBEDDING_DIMENSIONS),
  };
}

/** Stages the declared attempt and answers what it staged, refusing to continue if it did not. */
async function stage(client: any, scope: any, declared: Awaited<ReturnType<typeof declare>>) {
  const store = await import(storePath);
  const answer = await store.stageAttempt({
    scopeId: scope.id,
    attemptId: declared.attemptId,
    manifest: declared.manifest,
    readContent: declared.readContent,
    embed: declared.embed,
  });
  assert.equal(answer.code, "STAGED", `the attempt stages: ${answer.code}`);
  assert.ok(answer.staged, "a STAGED answer carries what it staged");
  return answer.staged;
}

/** Publishes the declared attempt from the stage this call made, the way a two-phase caller does. */
async function promote(client: any, scope: any, declared: Awaited<ReturnType<typeof declare>>, staged: any) {
  const store = await import(storePath);
  return store.finalizeAttempt({
    scopeId: scope.id,
    attemptId: declared.attemptId,
    requiredPaths: declared.requiredPaths,
    manifest: declared.manifest,
    readContent: declared.readContent,
    embed: declared.embed,
    staged,
  });
}

/** Stages and promotes in one call, which is what a connector does, and asserts it published. */
async function publishTree(client: any, scope: any, tree: readonly TreeFile[]) {
  const declared = await declare(client, scope, tree);
  const staged = await stage(client, scope, declared);
  const published = await promote(client, scope, declared, staged);
  assert.equal(published.code, "PUBLISHED", `the tree publishes: ${JSON.stringify(published)}`);
  return published;
}

/**
 * The production search for published content: `retrieve`, with its lexical half only, so the
 * answer depends on the stored `searchContent` and not on a model. Every hit carries the repository
 * path materialisation writes into the chunk metadata.
 */
async function search(projectId: string, query: string): Promise<string[]> {
  const { retrieve } = await import(retrieverPath);
  const answer = await retrieve({
    projectId,
    query,
    retrievalProfile: "legacy",
    useCache: false,
    useVector: false,
    hybridSearch: true,
    topK: 5,
    threshold: 0,
    rerank: false,
    compress: false,
  });
  return answer.results.map((entry: { metadata?: Record<string, unknown> }) => String(entry.metadata?.repo_path ?? ""));
}

/** The path rows the scope serves, in path order. */
async function servedPaths(client: any, scopeId: string): Promise<string[]> {
  const rows = await client.repoIndexPath.findMany({ where: { scopeId, state: "present" }, orderBy: { path: "asc" } });
  return rows.map((row: { path: string }) => row.path);
}

/** The documents a search can see, and the ones a stage wrote and nobody may: both counted. */
async function documentCounts(client: any, projectId: string) {
  return {
    live: await client.document.count({ where: { projectId, deletedAt: null } }),
    staged: await client.document.count({ where: { projectId, deletedAt: { not: null } } }),
  };
}

/** The tokens each fixture file carries; FTS stems them to themselves, so they are the query. */
const TOKEN = {
  keeper: "narwhal",
  before: "pangolin",
  after: "quokka",
  fresh: "zebrafish",
} as const;

const KEEPER: TreeFile = { path: "src/keeper.ts", content: `export const keeperToken = "${TOKEN.keeper}";\n` };
const CHANGED_BEFORE: TreeFile = { path: "src/changed.ts", content: `export const changedToken = "${TOKEN.before}";\n` };
const CHANGED_AFTER: TreeFile = { path: "src/changed.ts", content: `export const changedToken = "${TOKEN.after}";\n` };
const FRESH: TreeFile = { path: "src/fresh.ts", content: `export const freshToken = "${TOKEN.fresh}";\n` };

// Behaviour: a stage is invisible. The scope serves generation 1 throughout, the searches answer
// with generation 1's text only, and the rows the stage wrote are in the database the whole time -
// which is why this is a statement about visibility and not about nothing having happened.
test("a search between staging and promotion sees the generation it replaces, not the stage", async () => {
  const { client, project, scope } = await fixture();
  const first = await publishTree(client, scope, [KEEPER, CHANGED_BEFORE]);
  assert.equal(first.generation, 1, "the fixture published its first generation");
  assert.deepEqual(await search(project.id, TOKEN.before), ["src/changed.ts"], "the served text is findable");

  const declared = await declare(client, scope, [KEEPER, CHANGED_AFTER, FRESH]);
  const staged = await stage(client, scope, declared);

  // What the stage wrote: two paths whose content changed or is new, one reused as it was.
  assert.equal(staged.materialise.created, 2, "the changed path and the new one are staged");
  assert.equal(staged.materialise.reused, 1, "the unchanged path is reused, not re-embedded");
  assert.deepEqual(await documentCounts(client, project.id), { live: 2, staged: 2 }, "the staged documents exist and are not live");

  // The stage is written, and no reader can see any of it.
  assert.deepEqual(await search(project.id, TOKEN.after), [], "the staged text is not searchable");
  assert.deepEqual(await search(project.id, TOKEN.fresh), [], "a path only the stage holds is not searchable");
  assert.deepEqual(await search(project.id, TOKEN.before), ["src/changed.ts"], "the replaced text is still served");
  assert.deepEqual(await search(project.id, TOKEN.keeper), ["src/keeper.ts"], "and so is the reused one");

  // The served tree has not moved either: the scope still points at generation 1 and every present
  // path row belongs to it.
  const during = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(during.activeGeneration, 1, "a stage moves no generation");
  assert.deepEqual(await servedPaths(client, scope.id), ["src/changed.ts", "src/keeper.ts"], "and no path row");

  const promoted = await promote(client, scope, declared, staged);
  assert.equal(promoted.code, "PUBLISHED", `the promotion publishes the stage: ${JSON.stringify(promoted)}`);
  assert.equal(promoted.generation, 2, "it becomes the next generation");
  assert.deepEqual(promoted.materialise, staged.materialise, "and reports what the stage wrote");

  // One commit later the whole stage is what a search sees, and the text it replaced is gone.
  assert.deepEqual(await search(project.id, TOKEN.after), ["src/changed.ts"], "the staged text is searchable");
  assert.deepEqual(await search(project.id, TOKEN.fresh), ["src/fresh.ts"], "the new path too");
  assert.deepEqual(await search(project.id, TOKEN.before), [], "the replaced text is not");
  assert.deepEqual(await search(project.id, TOKEN.keeper), ["src/keeper.ts"], "the reused path still is");
  assert.deepEqual(await servedPaths(client, scope.id), ["src/changed.ts", "src/fresh.ts", "src/keeper.ts"]);
  assert.deepEqual(await documentCounts(client, project.id), { live: 3, staged: 0 }, "nothing is left staged");
});

// Behaviour: the fence still decides, and it decides after the work is staged. An attempt declared
// against a generation that has already moved is refused, so the stage it wrote never becomes
// visible, the scope keeps serving the generation it had, and the rows of the refused stage are
// gone rather than left behind as a document nothing can read.
test("a stage the fence refuses leaves the last good generation searchable and nothing behind", async () => {
  const { client, project, scope } = await fixture();
  const first = await publishTree(client, scope, [KEEPER, CHANGED_BEFORE]);
  assert.equal(first.generation, 1);

  // Declared against generation 0 while the scope serves generation 1: the base has moved, so the
  // fence answers SUPERSEDED_BASE - but only after this stage has written everything it has.
  const declared = await declare(client, scope, [KEEPER, CHANGED_AFTER, FRESH], { baseGeneration: 0 });
  const staged = await stage(client, scope, declared);
  assert.deepEqual(await documentCounts(client, project.id), { live: 2, staged: 2 }, "the refused attempt staged its rows first");

  const refused = await promote(client, scope, declared, staged);
  assert.equal(refused.code, "SUPERSEDED_BASE", `the fence refuses the stale base: ${JSON.stringify(refused)}`);
  assert.equal(refused.generationId, staged.generationId, "and names the attempt it refused");

  const after = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(after.activeGeneration, 1, "the scope still serves the generation it served");
  assert.deepEqual(await search(project.id, TOKEN.before), ["src/changed.ts"], "which is still searchable");
  assert.deepEqual(await search(project.id, TOKEN.after), [], "and the refused stage is not");
  assert.deepEqual(await search(project.id, TOKEN.fresh), [], "not even the path it would have added");
  assert.deepEqual(await documentCounts(client, project.id), { live: 2, staged: 0 }, "the refused stage left no row behind");
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), 2, "and no chunk of its own");
});

// Behaviour: abandoning an attempt between its stage and its promotion is the recovery a crash
// leaves behind. The attempt stops being publishable, its stage is dropped, and the generation
// readers see is untouched - which is what "the last good generation stays searchable" means when
// the writer never comes back.
test("an attempt abandoned after staging drops its stage and leaves the served generation live", async () => {
  const { client, project, scope } = await fixture();
  await publishTree(client, scope, [KEEPER, CHANGED_BEFORE]);

  const declared = await declare(client, scope, [KEEPER, CHANGED_AFTER, FRESH]);
  await stage(client, scope, declared);
  assert.deepEqual(await documentCounts(client, project.id), { live: 2, staged: 2 }, "the abandoned attempt staged its rows first");

  const store = await import(storePath);
  const abandoned = await store.abandonAttempt({ scopeId: scope.id, attemptId: declared.attemptId });
  assert.equal(abandoned.code, "ABANDONED");
  assert.deepEqual(await documentCounts(client, project.id), { live: 2, staged: 0 }, "the abandoned stage is dropped");
  assert.deepEqual(await search(project.id, TOKEN.before), ["src/changed.ts"], "the served generation is still searchable");
  assert.deepEqual(await search(project.id, TOKEN.after), [], "and the abandoned one never was");
  assert.equal(
    (await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } })).activeGeneration,
    1,
    "the scope never moved",
  );

  // The attempt cannot publish after its abandonment, so the rows it staged can never come back.
  const late = await promote(client, scope, declared, {
    scopeId: scope.id,
    attemptId: declared.attemptId,
    generationId: abandoned.generationId,
    stageId: "late",
    sourceId: null,
    stagedPaths: [],
    anchors: new Map(),
    materialise: { reused: 0, created: 0, chunks: 0 },
  });
  assert.equal(late.code, "ATTEMPT_FENCED", "a fenced attempt answers as fenced");
  assert.deepEqual(await documentCounts(client, project.id), { live: 2, staged: 0 });
});

after(async () => {
  if (!databaseUrl) return;
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  try {
    if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
    if (projectIds.length > 0) await client.project.deleteMany({ where: { id: { in: projectIds } } });
    assert.deepEqual(
      {
        scopes: await client.repoIndexScope.count({ where: { id: { in: scopeIds } } }),
        sources: await client.source.count({ where: { projectId: { in: projectIds } } }),
        documents: await client.document.count({ where: { projectId: { in: projectIds } } }),
        chunks: await client.chunk.count({ where: { projectId: { in: projectIds } } }),
      },
      { scopes: 0, sources: 0, documents: 0, chunks: 0 },
      "this file left no row behind",
    );
  } finally {
    await client.$disconnect();
    process.env = savedEnvironment;
  }
});
