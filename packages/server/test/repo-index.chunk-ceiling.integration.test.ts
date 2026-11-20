/**
 * The per-generation chunk ceiling as runtime configuration.
 *
 * `materialise.ts` used to answer one question with one literal: how many searchable chunks a
 * generation may plan before the publish transaction refuses it. This file pins the facts that make
 * the ceiling configurable and bounded without changing what anyone already runs:
 *
 * 1. Unset, the ceiling is still 2000 and a tree above it is still refused. Nothing is clamped
 *    and nothing upstream of the store decides it.
 * 2. Set above a tree's plan, the very same tree - same paths, same content, same reader, same
 *    embedder, same store - materialises. The two publications differ only in one environment
 *    variable, so the refusal was configuration and not the tree.
 * 3. A value that cannot be a ceiling (0, -1, 1.5, abc, or above the largest accepted) is refused
 *    instead of being clamped to something plausible, naming the variable and the value it received.
 *    A process configured with one refuses to load at all - before a publication can open a
 *    transaction - and the read-time check stays as the backstop for a value that changes after
 *    load: the refusal still reaches the publication, which rolls back leaving the scope on
 *    generation 0.
 * 4. The ceiling bounds the whole generation and not only the new work. A re-publication whose
 *    reused chunks plus its newly planned chunks cross the ceiling is refused, and the refusal
 *    states how much it would have reused and how much it planned; the same re-publication under a
 *    ceiling that covers the total publishes by reusing every path whose digest did not change.
 * 5. Every table these cases write is proven empty after each case, so a dropped cascade cannot
 *    leave rows behind a green run.
 *
 * Every write goes through the real store (`finalizeAttempt`), which is where production reads the
 * ceiling; the embedder is a deterministic pseudo-vector so no model is called.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
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

/**
 * Loads `materialise.ts` in a fresh process configured with `ceiling`, the way a deployment starts:
 * a child process is the only honest way to observe module-load behaviour from a test process that
 * has already imported the module. The child prints a marker only once the module finishes
 * evaluating, and it calls nothing else - so a marker means the load itself was accepted, and its
 * absence means the load itself was refused, never a later read.
 */
function loadWithCeiling(ceiling: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const moduleUrl = new URL("../src/engine/repo-index/materialise.ts", import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(() => console.log("LOADED"))`;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "-e", script],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, [CEILING_ENV]: ceiling }, timeout: 60_000 },
      (error, stdout, stderr) => {
        // A non-zero exit code is the assertion; a signal or a timeout is reported as 1 so it cannot
        // pass for the refusal under test (whose message is asserted separately below).
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
      },
    );
  });
}

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
 * One file of a published tree: its path, the digest the manifest states, and the content a reader
 * answers for it. The digest is what decides reuse, so a file whose digest changes is planned again.
 */
interface TreeFile {
  path: string;
  digest: string;
  content: string;
}

/**
 * The tree every test publishes. Its plan is above the default ceiling, which is what makes the
 * unset run refuse and the configured run publish: one tree, two answers, one variable.
 */
const TREE: readonly TreeFile[] = [
  { path: "src/alpha.ts", digest: "digest-alpha", content: "export const value = 1;\n" },
  { path: "docs/sections.md", digest: "digest-sections", content: sections(2400) },
  { path: "docs/notes.md", digest: "digest-notes", content: "## Notes\n\nTwo lines of notes.\n" },
];

/** What materialising TREE would plan, measured with the chunker rather than assumed. */
const PLAN = TREE.reduce((total, file) => total + searchableChunksOf(file.path, file.content), 0);

/**
 * The running total materialisation plans by the end of one path, in TREE's own manifest order.
 * That is the count a refusal names: chunking stops at the file that crosses the ceiling, so the
 * plan of the whole tree is not known there.
 */
function plannedBy(path: string): number {
  const last = TREE.findIndex((entry) => entry.path === path);
  return TREE.slice(0, last + 1).reduce((total, entry) => total + searchableChunksOf(entry.path, entry.content), 0);
}

/**
 * The tree the reuse cases publish twice: three files the second publication keeps (same path, same
 * digest, so their rows stay), and one file it rewrites (a new digest and new text, so that path is
 * planned again). Every count below is measured with the chunker, never assumed.
 */
const HELD_TREE: readonly TreeFile[] = [
  { path: "docs/held-alpha.md", digest: "digest-held-alpha", content: sections(2) },
  { path: "docs/held-beta.md", digest: "digest-held-beta", content: sections(2) },
  { path: "docs/held-gamma.md", digest: "digest-held-gamma", content: sections(2) },
];
const REWRITTEN_AT = "docs/rewritten.md";
/** The two texts of the one file the second publication rewrites: a new digest, and different words. */
const REWRITTEN_BEFORE = sections(2);
const REWRITTEN_AFTER = sections(2).replaceAll("is described", "was rewritten");
const FIRST_TREE: readonly TreeFile[] = [...HELD_TREE, { path: REWRITTEN_AT, digest: "digest-rewritten-1", content: REWRITTEN_BEFORE }];
const SECOND_TREE: readonly TreeFile[] = [...HELD_TREE, { path: REWRITTEN_AT, digest: "digest-rewritten-2", content: REWRITTEN_AFTER }];

/** Chunks the second publication reuses: every held path keeps the rows it already has. */
const HELD_CHUNKS = HELD_TREE.reduce((total, file) => total + searchableChunksOf(file.path, file.content), 0);
/** Chunks the second publication plans, because the one rewritten path has to be embedded again. */
const REWRITTEN_CHUNKS = searchableChunksOf(REWRITTEN_AT, REWRITTEN_AFTER);
/** What the first publication writes: the held paths plus the first version of the rewritten one. */
const FIRST_TOTAL = HELD_CHUNKS + searchableChunksOf(REWRITTEN_AT, REWRITTEN_BEFORE);
/** The chunks the second publication's generation holds, and so the total its ceiling must cover. */
const REUSE_TOTAL = HELD_CHUNKS + REWRITTEN_CHUNKS;
/**
 * A ceiling that covers the reused chunks and the new work each on its own, but not both together:
 * exactly the ceiling a check that only watched the new work let through.
 */
const REUSE_CEILING = Math.max(HELD_CHUNKS, REWRITTEN_CHUNKS);

/** One active scope with its own project, which a publication attributes its rows to. */
async function fixture() {
  const client = await testClient();
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
 * Opens the attempt `tree` publishes: one part declaring every path, so the finalize that follows
 * has what the store requires. Split from the finalize so a test can retry the very same attempt.
 */
async function openTreeAttempt(client: any, scope: any, tree: readonly TreeFile[] = TREE): Promise<string> {
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
    part: { upserts: tree.map((entry) => entry.path), tombstones: [] },
  });
  return attemptId;
}

/**
 * Finalizes one declared attempt through the store's own publish transaction. No ceiling is passed
 * in - the publication is given a reader, an embedder and nothing else, so the ceiling it obeys can
 * only come from the environment.
 */
async function finalizeTree(client: any, scope: any, attemptId: string, tree: readonly TreeFile[] = TREE) {
  const store = await import(storePath);
  const manifest = {
    digest: `digest-${attemptId}`,
    dimensions: EMBEDDING_DIMENSIONS,
    entries: tree.map((entry) => ({ path: entry.path, digest: entry.digest, vector: vectorOf(entry.path) })),
  };
  const byPath = new Map(tree.map((entry) => [entry.path, entry.content]));
  return store.finalizeAttempt({
    scopeId: scope.id,
    attemptId,
    requiredPaths: tree.map((entry) => entry.path),
    manifest,
    readContent: async (path: string) => byPath.get(path) as string,
    embed: pseudoEmbedder,
  });
}

/** Publishes `tree` in one go, the way a connector does: one attempt, then its finalize. */
async function publishTree(client: any, scope: any, tree: readonly TreeFile[] = TREE) {
  return finalizeTree(client, scope, await openTreeAttempt(client, scope, tree), tree);
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
    (error: { code?: string; path?: string; message?: string }) =>
      error instanceof MaterialiseError &&
      error.code === MATERIALISE_CODE.CHUNK_LIMIT &&
      error.path === "docs/sections.md" &&
      // The refusal an operator reads: the file, the chunks planned by that file, the split of the
      // generation (nothing reused on a first publication), the ceiling in force and the variable
      // that sets it. A path alone - what this used to answer - leaves them guessing at all four.
      error.message ===
        `${MATERIALISE_CODE.CHUNK_LIMIT}: docs/sections.md: planned ${plannedBy("docs/sections.md")} chunks so far - ` +
          `${plannedBy("docs/sections.md")} new, 0 reused - exceeding the ${MATERIALISE_LIMITS.maxChunksPerGeneration}-chunk ceiling ` +
          `set by ${CEILING_ENV} (unset, documented default)`,
    "an unset ceiling refuses the plan, naming the file, the plan so far, the ceiling in force and the variable that sets it",
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

    // The separator is accepted, because the largest ceiling is written `200_000` in the source and
    // in the docs: a variable that refused the spelling its own constant uses would be incoherent.
    for (const [spelled, expected] of [["200_000", 200000], ["2_000", 2000]] as const) {
      process.env[CEILING_ENV] = spelled;
      assert.equal(maxChunksPerGeneration(), expected, `${spelled} is a whole number of chunks`);
    }

    // The refused value is quoted and clipped: a newline would otherwise forge a second log line or
    // split a header, and a 4 KB paste would be echoed into every log and HTTP body that reports it.
    process.env[CEILING_ENV] = "1.5\nFORGED=1";
    assert.throws(
      () => maxChunksPerGeneration(),
      (error: Error) => error.message.includes(`${CEILING_ENV}="1.5\\nFORGED=1"`) && !error.message.includes("\n"),
      "a value carrying a newline is quoted and escaped, not pasted into the message",
    );
    process.env[CEILING_ENV] = "9".repeat(4096);
    assert.throws(
      () => maxChunksPerGeneration(),
      (error: Error) => error.message.includes(`${CEILING_ENV}="${"9".repeat(40)}..."`) && error.message.length < 400,
      "a 4 KB value is clipped to a readable echo",
    );
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
  const { MaterialiseConfigurationError } = await import(materialisePath);

  const { client, project, scope } = await fixture();
  const attemptId = await openTreeAttempt(client, scope);
  // The read-time check is the backstop for a value that changes after the process loaded: it is
  // still a configuration error, never a store failure, and it names the variable and the value.
  await assert.rejects(
    finalizeTree(client, scope, attemptId),
    (error: Error) =>
      error instanceof MaterialiseConfigurationError &&
      error.message.includes(CEILING_ENV) &&
      error.message.includes("1.5"),
    "the publication refuses with a configuration error naming the variable and the value it received",
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

// Behaviour: a value that cannot be a ceiling is the process's configuration, not the tree's size
// and not a store failure. It is refused as the module loads - before a publication has opened a
// transaction, taken the scope's row lock or sealed a generation - so an operator reads the variable
// and the value they typed instead of a broken database. A fresh process is the only honest way to
// observe module-load behaviour, so the assertions are the child's exit code and its stderr.
run("a value that cannot be a ceiling refuses the process at load, naming the variable and the value", async () => {
  const broken = await loadWithCeiling("1.5");
  assert.notEqual(broken.code, 0, `a process configured with 1.5 must not finish loading: ${broken.stdout}`);
  assert.equal(broken.stdout.includes("LOADED"), false, "the module never finished evaluating");
  assert.ok(broken.stderr.includes("MaterialiseConfigurationError"), `the refusal is a configuration error: ${broken.stderr}`);
  assert.ok(broken.stderr.includes(CEILING_ENV), "it names the variable");
  assert.ok(broken.stderr.includes("1.5"), "and the value it received");
  assert.equal(
    /STORE_FAILED|transaction|prisma/i.test(broken.stderr),
    false,
    `nothing about the store or a transaction is involved: ${broken.stderr}`,
  );

  // The control, so the refusal above is the value and not the way the child is started: the same
  // load with a value that can be a ceiling finishes, and prints the marker the refusal above lacks.
  const working = await loadWithCeiling("50000");
  assert.equal(working.code, 0, `a valid value loads: ${working.stderr}`);
  assert.ok(working.stdout.includes("LOADED"), `the module finishes evaluating with a valid ceiling: ${working.stdout}`);
});

// Behaviour: the ceiling bounds the whole generation, not just the new work. The second
// publication reuses HELD_CHUNKS rows and plans REWRITTEN_CHUNKS: a ceiling that covers either part
// alone and not their sum is refused, and the refusal states how much of it was reuse.
run("a re-publication above the ceiling is refused, reporting its reused and its new chunks", async () => {
  const { MATERIALISE_CODE, MaterialiseError } = await import(materialisePath);

  // Fixture sanity, measured: the ceiling holds the reused part and the new part, each on its own,
  // and not both together. Without that, the refusal below would prove nothing.
  assert.equal(REUSE_CEILING, HELD_CHUNKS, `the ceiling holds every reused chunk, ${HELD_CHUNKS}`);
  assert.ok(REWRITTEN_CHUNKS > 0 && REWRITTEN_CHUNKS <= REUSE_CEILING, `the new work alone fits, plans ${REWRITTEN_CHUNKS}`);
  assert.ok(REUSE_TOTAL > REUSE_CEILING, `the generation would hold ${REUSE_TOTAL} chunks against ${REUSE_CEILING}`);

  const { client, project, scope } = await fixture();
  const { first, attemptId } = await firstPublicationThenRewrite(client, scope);
  assert.equal(first.materialise?.reused, 0, "the first publication reuses nothing");
  assert.equal(first.materialise?.chunks, FIRST_TOTAL, "and writes every chunk of its tree");

  process.env[CEILING_ENV] = String(REUSE_CEILING);
  await assert.rejects(
    finalizeTree(client, scope, attemptId, SECOND_TREE),
    (error: any) => {
      assert.ok(error instanceof MaterialiseError, `the refusal is a materialisation refusal: ${String(error)}`);
      assert.equal(error.code, MATERIALISE_CODE.CHUNK_LIMIT, "the ceiling decided it, not the tree");
      assert.equal(error.path, REWRITTEN_AT, "and it names the file whose new chunks crossed the ceiling");
      assert.equal(error.tally?.reused, HELD_CHUNKS, "the refusal reports the reused part");
      assert.equal(error.tally?.planned, REWRITTEN_CHUNKS, "and the part it planned");
      assert.equal(error.tally?.ceiling, REUSE_CEILING, "against the ceiling in force");
      assert.equal(error.tally?.source, `${CEILING_ENV}=${REUSE_CEILING}`, "and the setting the ceiling came from");
      assert.match(error.message, new RegExp(`\\b${HELD_CHUNKS} reused\\b`), "the message states the reused part");
      assert.match(error.message, new RegExp(`\\b${REWRITTEN_CHUNKS} new\\b`), "and the new part");
      assert.match(error.message, new RegExp(`set by ${CEILING_ENV}=${REUSE_CEILING}`), "and the variable that set the ceiling");
      return true;
    },
    "a generation whose total crosses the ceiling is refused, though its new work alone fits",
  );

  // Rolled back with the rest of the transaction: the scope still serves the first publication, with
  // every chunk it wrote, and the refused attempt is the only row the re-publication added.
  const served = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(served.activeGeneration, 1, "the refused re-publication moved nothing");
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), FIRST_TOTAL, "and dropped no chunk");
  assert.equal(
    (await client.repoIndexGeneration.findMany({ where: { scopeId: scope.id } })).length,
    2,
    "the refused attempt is still the one retryable row",
  );
});

// Behaviour: the same re-publication under a ceiling that covers the total publishes, and it reuses
// the paths whose digest did not change instead of embedding them again. The ceiling is set to the
// total itself, which is the inclusive maximum: a ceiling read as exclusive would refuse here.
run("the same re-publication publishes under a ceiling that covers the total", async () => {
  const { client, project, scope } = await fixture();
  const { attemptId } = await firstPublicationThenRewrite(client, scope);
  const chunksBefore = await chunkIdsByPath(client, project.id);

  process.env[CEILING_ENV] = String(REUSE_TOTAL);
  const published = await finalizeTree(client, scope, attemptId, SECOND_TREE);

  assert.equal(published.code, "PUBLISHED", `a ceiling that covers the total publishes: ${JSON.stringify(published)}`);
  assert.equal(published.materialise?.reused, HELD_TREE.length, "every held path is reused");
  assert.equal(published.materialise?.created, 1, "only the rewritten path is written");
  assert.equal(published.materialise?.chunks, REWRITTEN_CHUNKS, "and only the rewritten path's chunks are written");

  // The generation holds the total, and the held paths keep the very rows they had: reuse means no
  // re-embedding, which the chunks table proves independently of the answer the store returns.
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), REUSE_TOTAL, "the generation holds the total");
  const chunksAfter = await chunkIdsByPath(client, project.id);
  for (const held of HELD_TREE) {
    assert.deepEqual(chunksAfter.get(held.path), chunksBefore.get(held.path), `${held.path} keeps the chunks it had`);
  }
  assert.notDeepEqual(chunksAfter.get(REWRITTEN_AT), chunksBefore.get(REWRITTEN_AT), "the rewritten path has new chunks");
  assert.equal(
    (await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } })).activeGeneration,
    2,
    "the publication became the generation the scope serves",
  );
});

// Behaviour: the pure case of "the total the generation holds". Nothing changed between the two
// publications, so no new work is planned at all and the ceiling is judging reuse alone: a lowered
// ceiling refuses a generation it can no longer hold instead of publishing it unmeasured.
run("a re-publication whose reuse alone crosses the ceiling is refused with no new work", async () => {
  const { MATERIALISE_CODE, MaterialiseError } = await import(materialisePath);
  const { client, project, scope } = await fixture();

  process.env[CEILING_ENV] = String(FIRST_TOTAL + 100);
  const first = await publishTree(client, scope, FIRST_TREE);
  assert.equal(first.code, "PUBLISHED", `the first publication must publish: ${JSON.stringify(first)}`);
  assert.equal(first.materialise?.chunks, FIRST_TOTAL, "and writes every chunk of its tree");

  // The same tree again: every path keeps its digest, so every chunk is reused and none is planned.
  const ceiling = FIRST_TOTAL - 1;
  process.env[CEILING_ENV] = String(ceiling);
  await assert.rejects(
    publishTree(client, scope, FIRST_TREE),
    (error: any) => {
      assert.ok(error instanceof MaterialiseError, `the refusal is a materialisation refusal: ${String(error)}`);
      assert.equal(error.code, MATERIALISE_CODE.CHUNK_LIMIT, "the ceiling decided it");
      assert.equal(error.path, undefined, "no file crossed it: the total was already over");
      assert.equal(error.tally?.reused, FIRST_TOTAL, "the refusal is all reuse");
      assert.equal(error.tally?.planned, 0, "and no new work");
      assert.equal(error.tally?.ceiling, ceiling, "against the ceiling in force");
      assert.match(error.message, new RegExp(`\\b${FIRST_TOTAL} reused\\b`), "the message states the reused part");
      assert.match(error.message, /\b0 new\b/, "and that nothing new was planned");
      return true;
    },
    "a generation that only reuses chunks is still measured against the ceiling",
  );

  const served = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(served.activeGeneration, 1, "the refused re-publication moved nothing");
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), FIRST_TOTAL, "and kept every chunk");
});

/**
 * The first publication of the reuse cases, then the attempt that rewrites one of its files. The
 * first run is given room to spare, so only the re-publication is measured against the ceiling.
 */
async function firstPublicationThenRewrite(client: any, scope: any) {
  process.env[CEILING_ENV] = String(REUSE_TOTAL + 100);
  const first = await publishTree(client, scope, FIRST_TREE);
  assert.equal(first.code, "PUBLISHED", `the first publication must publish: ${JSON.stringify(first)}`);
  return { first, attemptId: await openTreeAttempt(client, scope, SECOND_TREE) };
}

/**
 * Every chunk row of the case's project, by path, in chunk order. The rows themselves, not the
 * outcome the store reports: this is what a reuse keeps and what a rewrite replaces.
 */
async function chunkIdsByPath(client: any, projectId: string): Promise<Map<string, string[]>> {
  const rows = (await client.$queryRaw`
    SELECT d."externalId" AS "path", c."id"::text AS "id"
    FROM "chunks" c
    JOIN "documents" d ON d."id" = c."documentId"
    WHERE d."projectId" = ${projectId}
    ORDER BY d."externalId", c."chunkIndex"
  `) as Array<{ path: string; id: string }>;
  const byPath = new Map<string, string[]>();
  for (const row of rows) byPath.set(row.path, [...(byPath.get(row.path) ?? []), row.id]);
  return byPath;
}

/**
 * Every table these cases write, counted for the rows their fixtures created. The scope owns its
 * generations, their parts and its paths; the project owns the source, and the source owns the
 * documents and their chunks. Each count is a read, so a cascade that stopped working shows here.
 */
async function countsOf(client: any) {
  return {
    scopes: await client.repoIndexScope.count({ where: { id: { in: scopeIds } } }),
    generations: await client.repoIndexGeneration.count({ where: { scopeId: { in: scopeIds } } }),
    parts: await client.repoIndexPart.count({ where: { generation: { scopeId: { in: scopeIds } } } }),
    paths: await client.repoIndexPath.count({ where: { scopeId: { in: scopeIds } } }),
    projects: await client.project.count({ where: { id: { in: projectIds } } }),
    sources: await client.source.count({ where: { projectId: { in: projectIds } } }),
    documents: await client.document.count({ where: { projectId: { in: projectIds } } }),
    chunks: await client.chunk.count({ where: { projectId: { in: projectIds } } }),
  };
}

/** What a clean database answers for every table these cases wrote. */
const NO_ROWS = { scopes: 0, generations: 0, parts: 0, paths: 0, projects: 0, sources: 0, documents: 0, chunks: 0 };

/** The process's Prisma client: every case and both hooks use the one connection. */
async function testClient(): Promise<any> {
  const { db } = await import("../src/db/index.js");
  return db as any;
}

/**
 * Removes what the cases published, then proves every table they wrote is empty. A cascade that
 * stopped working would leave rows here while the publication cases stayed green, so the counts
 * after the delete are the evidence, not the delete's own exit code.
 */
async function cleanup(client: any): Promise<void> {
  // The scope owns its generations, their parts and its paths: one delete takes all of them.
  if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
  // The synthetic source, its documents and their chunks hang off the project.
  if (projectIds.length > 0) await client.project.deleteMany({ where: { id: { in: projectIds } } });

  // Proven empty, not assumed: all eight tables these cases wrote hold none of their rows.
  assert.deepEqual(await countsOf(client), NO_ROWS, "cleanup left no row in any table these cases wrote");
}

// Every case proves its own cleanup, so a leftover surfaces on the case that wrote it. The ceiling
// is cleared with the rows: a case that leaves it set would decide the next case's premise, and the
// cases that spawn a fresh process for the module-load refusal would inherit it.
afterEach(async () => {
  delete process.env[CEILING_ENV];
  if (!databaseUrl) return;
  await cleanup(await testClient());
});

after(async () => {
  process.env = savedEnvironment;
  if (!databaseUrl) return;
  await (await testClient()).$disconnect();
});
