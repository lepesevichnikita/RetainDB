/**
 * The per-generation chunk ceiling as runtime configuration.
 *
 * `materialise.ts` used to answer one question with one literal: how many searchable chunks a
 * generation may plan before the publish transaction refuses it. This file pins the three facts
 * that make the ceiling configurable without changing what anyone already runs:
 *
 * 1. Unset, the ceiling is still 2000 and a tree above it is still refused. Nothing is clamped
 *    and nothing upstream of the store decides it.
 * 2. Set above a tree's plan, the very same tree - same paths, same content, same reader, same
 *    embedder, same store - materialises. The two publications differ only in one environment
 *    variable, so the refusal was configuration and not the tree.
 * 3. A value that cannot be a ceiling (0, -1, 1.5, abc, or above the largest accepted) is refused
 *    when it is read, naming the variable and the value it received, instead of being clamped to
 *    something plausible. The refusal reaches the publication itself, which rolls back leaving the
 *    scope on generation 0.
 *
 * Every write goes through the real store (`finalizeAttempt`), which is where production reads the
 * ceiling; the embedder is a deterministic pseudo-vector so no model is called.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { chunkText } from "../src/engine/chunker.js";
import { EMBEDDING_DIMENSIONS } from "../src/engine/repo-index/receipt.js";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const savedEnvironment = { ...process.env };
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
} else {
  /** The store builds a Prisma client as it loads, so the process needs a well-formed URL. */
  process.env.DATABASE_URL = "postgresql://chunk-ceiling:***@127.0.0.1:1/unreachable";
}

const materialisePath = "../src/engine/repo-index/materialise.js";
const storePath = "../src/engine/repo-index/store.js";

/** The variable under test: the only way to configure the ceiling, unset by default. */
const CEILING_ENV = "RETAINDB_REPO_INDEX_MAX_CHUNKS_PER_GENERATION";

/** Every scope and project this file created, removed once the suite finishes. */
const scopeIds: string[] = [];
const projectIds: string[] = [];

/** A 1024-dimension vector with one non-zero element: storable, and small enough to insert fast. */
function vectorOf(text: string): number[] {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  vector[1] = text.length / 1000;
  return vector;
}

/** The embedder the publication would call for chunk text; deterministic and model-free. */
const pseudoEmbedder = async (texts: string[]): Promise<number[][]> => texts.map(vectorOf);

/** The searchable chunks one file contributes, decided exactly as materialise.ts decides it. */
function searchableChunksOf(path: string, content: string): number {
  if (!content.trim()) return 0;
  return chunkText(content, { filePath: path }).chunks.filter((chunk) => chunk.searchable).length;
}

/**
 * A markdown file of `count` sections. The chunker answers one searchable chunk per section, so
 * this file's size is a plan size a test can choose: the tree below plans well above the default
 * ceiling without carrying megabytes of text.
 */
function sections(count: number): string {
  const parts: string[] = [];
  for (let index = 0; index < count; index++) parts.push(`## Section ${index}\n\nItem ${index} is described here.\n`);
  return parts.join("\n");
}

/**
 * The tree every test publishes. Its plan is above the default ceiling, which is what makes the
 * unset run refuse and the configured run publish: one tree, two answers, one variable.
 */
const TREE = [
  { path: "src/alpha.ts", digest: "digest-alpha", content: "export const value = 1;\n" },
  { path: "docs/sections.md", digest: "digest-sections", content: sections(2400) },
  { path: "docs/notes.md", digest: "digest-notes", content: "## Notes\n\nTwo lines of notes.\n" },
];

/** What materialising TREE would plan, measured with the chunker rather than assumed. */
const PLAN = TREE.reduce((total, file) => total + searchableChunksOf(file.path, file.content), 0);

/** One active scope with its own project, which a publication attributes its rows to. */
async function fixture() {
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  const name = `chunk-ceiling-${randomUUID()}`;
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
      headCommit: "commit-0f0f",
      policyVersion: "policy-1",
      pipelineVersion: "pipeline-1",
    },
  });
  scopeIds.push(scope.id);
  return { client, project, scope };
}

/**
 * Opens the attempt TREE publishes: one part declaring every path, so the finalize that follows has
 * what the store requires. Split from the finalize so a test can retry the very same attempt.
 */
async function openTreeAttempt(client: any, scope: any): Promise<string> {
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
  await store.putPart({
    scopeId: scope.id,
    attemptId,
    partNo: 1,
    part: { upserts: TREE.map((entry) => entry.path), tombstones: [] },
  });
  return attemptId;
}

/**
 * Finalizes one declared attempt through the store's own publish transaction. No ceiling is passed
 * in - the publication is given a reader, an embedder and nothing else, so the ceiling it obeys can
 * only come from the environment.
 */
async function finalizeTree(client: any, scope: any, attemptId: string) {
  const store = await import(storePath);
  const manifest = {
    digest: `digest-${attemptId}`,
    dimensions: EMBEDDING_DIMENSIONS,
    entries: TREE.map((entry) => ({ path: entry.path, digest: entry.digest, vector: vectorOf(entry.path) })),
  };
  const byPath = new Map(TREE.map((entry) => [entry.path, entry.content]));
  return store.finalizeAttempt({
    scopeId: scope.id,
    attemptId,
    requiredPaths: TREE.map((entry) => entry.path),
    manifest,
    readContent: async (path: string) => byPath.get(path) as string,
    embed: pseudoEmbedder,
  });
}

/** Publishes TREE in one go, the way a connector does: one attempt, then its finalize. */
async function publishTree(client: any, scope: any) {
  return finalizeTree(client, scope, await openTreeAttempt(client, scope));
}

/** The chunk rows the scope's synthetic source holds, by path: the search surface itself. */
async function chunksByPath(client: any, scopeId: string) {
  const rows = await client.$queryRaw`
    SELECT d."externalId" AS "path", COUNT(c."id")::int AS "chunks"
    FROM "documents" d
    LEFT JOIN "chunks" c ON c."documentId" = d."id"
    WHERE d."sourceId" = (SELECT s."id" FROM "sources" s WHERE s."name" = ${`repo-index:${scopeId}`})
    GROUP BY d."externalId"
    ORDER BY d."externalId"
  `;
  return rows as Array<{ path: string; chunks: number }>;
}

// Behaviour: with the variable unset the ceiling is the documented default of 2000, and the tree
// this file publishes is still refused. This is the run every existing deployment makes, so it is
// asserted first: configurability must not move the default.
run("unset, the ceiling is 2000 and an over-sized tree is still refused", async () => {
  const { MATERIALISE_CODE, MATERIALISE_LIMITS, MaterialiseError, maxChunksPerGeneration } = await import(materialisePath);
  delete process.env[CEILING_ENV];

  assert.equal(maxChunksPerGeneration(), 2000, "an unset ceiling is the documented default");
  assert.equal(MATERIALISE_LIMITS.maxChunksPerGeneration, 2000, "and that default is the constant every caller reads");
  assert.ok(PLAN > 2000, `the fixture tree must cross the default ceiling, plans ${PLAN} chunks`);

  const { client, project, scope } = await fixture();
  await assert.rejects(
    publishTree(client, scope),
    (error: { code?: string; path?: string }) =>
      error instanceof MaterialiseError && error.code === MATERIALISE_CODE.CHUNK_LIMIT && error.path === "docs/sections.md",
    "an unset ceiling refuses the plan, naming the file that crossed it",
  );

  const scopeAfter = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, 0, "the refused publication moved nothing");
  assert.equal(await client.document.count({ where: { projectId: project.id } }), 0, "and wrote no document");
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), 0, "and no chunk");
});

// Behaviour: the same tree, the same reader and the same embedder publish once the ceiling is
// configured above the plan. Nothing about the tree changes between the two runs, so the flip from
// CHUNK_LIMIT to PUBLISHED is the configuration and nothing else.
run("set above the plan, the same tree materialises instead of refusing", async () => {
  const { maxChunksPerGeneration } = await import(materialisePath);
  const ceiling = PLAN + 100;
  process.env[CEILING_ENV] = String(ceiling);

  assert.equal(maxChunksPerGeneration(), ceiling, "the configured ceiling is the one in force");

  const { client, project, scope } = await fixture();
  const published = await publishTree(client, scope);

  assert.equal(published.code, "PUBLISHED", `the configured ceiling lets the tree publish: ${JSON.stringify(published)}`);
  assert.equal(published.materialise?.created, TREE.length, "every path of the tree is created");
  assert.equal(published.materialise?.chunks, PLAN, "and every chunk the plan measured is written");

  // The search surface holds the plan's chunks, path for path: a published answer that wrote no
  // chunk would claim a tree semantic search cannot return.
  const stored = await chunksByPath(client, scope.id);
  assert.deepEqual(
    stored.map((row) => [row.path, row.chunks]),
    TREE.map((entry) => [entry.path, searchableChunksOf(entry.path, entry.content)]).sort(([left], [right]) =>
      String(left).localeCompare(String(right)),
    ),
    "each path holds the chunks the chunker plans for it",
  );
  assert.equal(stored.reduce((total, row) => total + row.chunks, 0), PLAN);
  assert.equal(
    await client.chunk.count({ where: { projectId: project.id } }),
    PLAN,
    "the chunks belong to the scope's project",
  );
  assert.equal(
    (await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } })).activeGeneration,
    1,
    "the publication became the generation the scope serves",
  );
});

// Behaviour: a value that cannot be a ceiling is refused when it is read, and the refusal names
// the variable and what it received. Clamping would hide the value an operator set, so each shape
// the language lets through is enumerated: zero, a negative, a fraction, text, a non-finite value,
// the value one above the largest accepted, and a number no repository could reach.
run("a value that cannot be a ceiling is refused, naming the variable and the value", async () => {
  const { maxChunksPerGeneration } = await import(materialisePath);
  const invalid = ["0", "-1", "1.5", "abc", "Infinity", "NaN", "200001", "1000000000"];

  try {
    // `.env.example` ships this line with no value, so an empty or blank setting has to mean the
    // default: copying the example must not make every publication refuse.
    for (const unset of ["", "   "]) {
      process.env[CEILING_ENV] = unset;
      assert.equal(maxChunksPerGeneration(), 2000, `${JSON.stringify(unset)} means the documented default`);
    }
    for (const received of invalid) {
      process.env[CEILING_ENV] = received;
      assert.throws(
        () => maxChunksPerGeneration(),
        (error: Error) => error.message.includes(CEILING_ENV) && error.message.includes(received),
        `${received} must be refused with the variable and the value in the message`,
      );
    }
  } finally {
    delete process.env[CEILING_ENV];
  }
});

// Behaviour: the refusal reaches the publication, not only the reader. A misconfigured process
// refuses loudly at the point a generation is materialised, and the transaction rolls back: the
// scope stays on generation 0 with no document and no chunk, and the attempt is left open. Fixed,
// that same attempt publishes, so the refusal was the value and not a broken store.
run("an invalid ceiling refuses the publication, rolls it back, and the same attempt then publishes", async () => {
  process.env[CEILING_ENV] = "1.5";

  const { client, project, scope } = await fixture();
  const attemptId = await openTreeAttempt(client, scope);
  await assert.rejects(
    finalizeTree(client, scope, attemptId),
    (error: Error) => error.message.includes(CEILING_ENV) && error.message.includes("1.5"),
    "the publication refuses with the variable and the value it received",
  );

  const scopeAfter = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, 0, "the refused publication moved nothing");
  const generations = await client.repoIndexGeneration.findMany({ where: { scopeId: scope.id } });
  assert.equal(generations.length, 1);
  assert.equal(generations[0].status, "open", "the attempt is still retryable once the value is fixed");
  assert.equal(await client.document.count({ where: { projectId: project.id } }), 0);
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), 0);

  // The same attempt, the same tree, a value that can be a ceiling: it publishes.
  process.env[CEILING_ENV] = String(PLAN + 100);
  const published = await finalizeTree(client, scope, attemptId);
  assert.equal(published.code, "PUBLISHED", `the retried attempt publishes: ${JSON.stringify(published)}`);
  assert.equal(published.materialise?.chunks, PLAN);
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), PLAN);
  delete process.env[CEILING_ENV];
});

after(async () => {
  process.env = savedEnvironment;
  if (!databaseUrl) return;
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  try {
    if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
    if (projectIds.length > 0) await client.project.deleteMany({ where: { id: { in: projectIds } } });
    assert.equal(await client.repoIndexScope.count({ where: { id: { in: scopeIds } } }), 0);
    assert.equal(await client.document.count({ where: { projectId: { in: projectIds } } }), 0);
    assert.equal(await client.chunk.count({ where: { projectId: { in: projectIds } } }), 0);
  } finally {
    await client.$disconnect();
  }
});
