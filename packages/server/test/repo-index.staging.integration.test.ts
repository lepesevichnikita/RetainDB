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
const materialisePath = "../src/engine/repo-index/materialise.js";
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

/**
 * A transaction handle that passes every call through to the real one and records the statement
 * each write issued. Purpose-built for the two cases below: they measure round trips, so what they
 * need from the handle is a name for every statement, not a different answer. A model delegate
 * (`document`, `source`) is wrapped the same way, so a write made through Prisma's typed API is
 * counted beside a raw one.
 */
function recording(handle: any): { handle: any; statements: string[] } {
  const statements: string[] = [];
  const record = (name: string, call: (...args: any[]) => any, target: any) =>
    (...args: any[]) => {
      statements.push(name);
      return call.apply(target, args);
    };
  const delegate = (property: string, value: any) =>
    new Proxy(value, {
      get(model, method) {
        const call = Reflect.get(model, method);
        return typeof call === "function" ? record(`${property}.${String(method)}`, call, model) : call;
      },
    });
  const proxy = new Proxy(handle, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "document" || property === "source") return delegate(String(property), value);
      if (typeof value !== "function") return value;
      if (property === "$executeRaw" || property === "$executeRawUnsafe") {
        return (first: any, ...rest: any[]) => {
          statements.push(Array.isArray(first) ? first.join("$?") : String(first));
          return value.apply(target, [first, ...rest]);
        };
      }
      return value.bind(target);
    },
  });
  return { handle: proxy, statements };
}

/** One fixture file whose content chunks into `sections` headings, so a batch holds many chunks. */
function sectionedFile(index: number, sections: number): TreeFile {
  const content = Array.from(
    { length: sections },
    (_, section) => `## part ${section}\n\nexport const value${section} = "${index}-${section}";\n// ${"filler ".repeat(20)}\n`,
  ).join("\n");
  return { path: `docs/batch-${index}.md`, content };
}

/**
 * What one batch of a plan is: the paths it writes and the chunk rows it must produce. The two
 * cases below read this instead of restating the plan, so they compare the database against what
 * the production planner asked for.
 */
async function plannedBatch(tree: readonly TreeFile[], scopeId: string, projectId: string) {
  const { db } = await import("../src/db/index.js");
  const materialise = await import(materialisePath);
  const { EMBEDDING_DIMENSIONS } = await import(receiptPath);
  const byPath = new Map(tree.map((file) => [file.path, file.content] as const));
  const plan = await materialise.planMaterialisation(db, {
    scopeId,
    projectId,
    paths: tree.map((file) => ({ path: file.path, digest: createHash("sha256").update(file.content, "utf8").digest("hex") })),
    readContent: async (path: string) => byPath.get(path) as string,
    embed: embedder(EMBEDDING_DIMENSIONS),
  });
  return { plan, byPath };
}

// Behaviour: one staging batch is a bounded number of statements. Staging was round-trip bound -
// every chunk cost a statement of its own, so a tree of 5,000 chunks paid 5,000 of them and a
// larger tree spent minutes inside a phase that never fails, it only gets slower. This counts the
// statements one batch of eight files issues against the real database, and the case below checks
// that the rows that bounded set of statements wrote are the rows the plan asked for.
test("one staging batch writes every chunk of a file in one statement, not one per chunk", async () => {
  const { client, project, scope } = await fixture();
  const tree = Array.from({ length: 8 }, (_, index) => sectionedFile(index, 5));
  const { plan } = await plannedBatch(tree, scope.id, project.id);
  const materialise = await import(materialisePath);
  const { prisma } = await import("../src/db/index.js");
  const owner = { scopeId: scope.id, projectId: project.id, orgId: "default" };

  // The scope's source is created by the first batch that needs one, which is a one-off per scope;
  // staged empty, it leaves the measured batch below the shape a publication's later batches have.
  await prisma.$transaction((tx: any) =>
    materialise.stageBatch(tx, { ...owner, generationId: randomUUID(), stageId: randomUUID(), stagedAt: new Date(), paths: [] }),
  );

  const measured = await prisma.$transaction(async (tx: any) => {
    const recorder = recording(tx);
    const staged = await materialise.stageBatch(recorder.handle, {
      ...owner,
      generationId: randomUUID(),
      stageId: randomUUID(),
      stagedAt: new Date(),
      paths: plan.pending,
    });
    return { staged, statements: recorder.statements };
  });

  const chunks = plan.pending.reduce((total, entry) => total + entry.chunks.length, 0);
  const inserting = (table: string) => measured.statements.filter((statement) => statement.includes(`INSERT INTO "${table}"`)).length;
  assert.ok(chunks > tree.length * 2, `the fixture batch holds enough chunks to have paid a statement each: ${chunks}`);
  assert.equal(inserting("chunks"), 1, `one statement writes every chunk of the batch, not ${chunks}: ${measured.statements.length} statements in all`);
  assert.equal(inserting("documents"), 1, `and one writes its documents, not ${tree.length}`);
  // Three statements: the source this batch writes into, its documents and its chunks - whatever
  // the batch holds. It was one per row before: a chunk of 40 rows cost 40 statements of its own.
  assert.ok(
    measured.statements.length <= 3,
    `a batch of ${tree.length} files and ${chunks} chunks is three statements, not one per row: ${measured.statements.length}`,
  );
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), chunks, "every chunk of the batch is written");
  assert.equal(await client.document.count({ where: { projectId: project.id, deletedAt: { not: null } } }), tree.length, "and one staged document per file");
  // The anchors are unchanged: one first chunk per file that has chunks, in plan order.
  assert.deepEqual(
    (measured.staged.anchors as Array<{ path: string; chunkId: string }>).map((anchor) => anchor.path),
    plan.pending.filter((entry) => entry.chunks.length > 0).map((entry) => entry.path),
    "each staged file still answers its first chunk as the anchor",
  );
});

// Behaviour: a batch writes the same rows it always wrote. A multi-row statement is one column
// list, so a value in the wrong place is the failure this rewrite invites: every column of every
// staged row is compared against the plan that asked for it, including the vector the embedder
// returned (through the float4 the `vector` column stores) and the metadata the chunker wrote.
test("a staged batch writes the rows its plan asked for, column for column", async () => {
  const { client, project, scope } = await fixture();
  const tree = [sectionedFile(0, 3), sectionedFile(1, 1), { path: "docs/empty.md", content: "" }];
  const { plan } = await plannedBatch(tree, scope.id, project.id);
  const materialise = await import(materialisePath);
  const { prisma } = await import("../src/db/index.js");
  const { EMBEDDING_DIMENSIONS } = await import(receiptPath);
  const stagedAt = new Date();

  const staged = await prisma.$transaction(async (tx: any) =>
    materialise.stageBatch(tx, {
      scopeId: scope.id,
      projectId: project.id,
      orgId: "default",
      generationId: randomUUID(),
      stageId: randomUUID(),
      stagedAt,
      paths: plan.pending,
    }),
  );

  // The documents: one per path, keyed by the digest the fence compares, invisible until promotion.
  const documents = (await client.$queryRawUnsafe(
    `SELECT id, "externalId", title, path, "contentHash", content, tokens, status, metadata, "deletedAt", "sourceId", "projectId"
       FROM "documents" WHERE "projectId" = $1 ORDER BY "externalId"`,
    project.id,
  )) as any[];
  assert.deepEqual(documents.map((row) => row.externalId).sort(), tree.map((file) => file.path).sort(), "one document per path");
  for (const entry of plan.pending) {
    const document = documents.find((row) => row.externalId === entry.path);
    const digest = createHash("sha256").update(entry.content, "utf8").digest("hex");
    assert.ok(document, `the document of ${entry.path} was written`);
    assert.equal(document.id.length, 36, "the document id is a generated uuid");
    assert.equal(document.title, entry.path, `the title of ${entry.path} is its path`);
    assert.equal(document.path, entry.path, `the stored path of ${entry.path}`);
    assert.equal(document.contentHash, digest, `the digest of ${entry.path}`);
    assert.equal(document.content, entry.content, `the content of ${entry.path}`);
    assert.equal(document.tokens, Math.ceil(entry.content.length / 4), `the token estimate of ${entry.path}`);
    assert.equal(document.status, "PENDING", `a staged document of ${entry.path} is not indexed yet`);
    assert.equal(document.deletedAt?.getTime(), stagedAt.getTime(), `a staged document of ${entry.path} carries the stage time in deletedAt`);
    assert.equal(document.sourceId, staged.sourceId, `the document of ${entry.path} belongs to the scope's source`);
    assert.equal(document.projectId, project.id, `the document of ${entry.path} belongs to the project`);
    assert.deepEqual(
      { repo_path: document.metadata.repo_path, repo_digest: document.metadata.repo_digest, repo_scope_id: document.metadata.repo_scope_id },
      { repo_path: entry.path, repo_digest: digest, repo_scope_id: scope.id },
      `the document metadata of ${entry.path} names its path, digest and scope`,
    );
    assert.ok(document.metadata.repo_index_generation_id, `the staged generation of ${entry.path} is recorded`);
    assert.ok(document.metadata.repo_index_stage_id, `the stage of ${entry.path} is recorded`);
  }

  // The chunks: every column the single statement writes, against the prepared chunk it came from.
  const chunks = (await client.$queryRawUnsafe(
    `SELECT d."externalId" AS path, c."documentId", c."projectId", c.content, c."chunkType", c."chunkIndex",
            c.metadata, c.tokens, c."searchContent", c."contentHash", c."sectionPath", c."headingPath",
            c.embedding::text AS embedding, c."createdAt", c."updatedAt"
       FROM "chunks" c JOIN "documents" d ON d.id = c."documentId"
      WHERE c."projectId" = $1 ORDER BY d."externalId", c."chunkIndex"`,
    project.id,
  )) as any[];
  const prepared = plan.pending.flatMap((entry) => entry.chunks.map((chunk) => ({ path: entry.path, digest: entry.digest, ...chunk })));
  prepared.sort((left, right) => (left.path === right.path ? left.chunk.chunkIndex - right.chunk.chunkIndex : left.path < right.path ? -1 : 1));
  assert.equal(chunks.length, prepared.length, `every prepared chunk is a row: ${prepared.length}`);
  assert.equal(chunks.length, 4, `the fixture plan holds four chunks: ${chunks.length}`);

  for (const [index, row] of chunks.entries()) {
    const expected = prepared[index];
    const content = expected.chunk.content;
    assert.equal(row.path, expected.path, `row ${index} belongs to ${expected.path}`);
    assert.equal(row.content, content, `row ${index} holds its chunk text`);
    assert.equal(row.chunkType, expected.chunk.chunkType, `row ${index} holds its chunk type`);
    assert.equal(row.chunkIndex, expected.chunk.chunkIndex, `row ${index} holds its chunk index`);
    assert.equal(row.projectId, project.id, `row ${index} belongs to the project`);
    assert.equal(row.documentId.length, 36, `row ${index} is linked to a generated document id`);
    assert.equal(row.tokens, Math.ceil(content.length / 4), `row ${index} holds its token estimate`);
    assert.equal(row.contentHash, createHash("sha256").update(content, "utf8").digest("hex"), `row ${index} holds its content hash`);
    assert.equal(
      row.searchContent,
      [expected.path, expected.chunk.headingPath, expected.chunk.sectionPath, content].filter(Boolean).join("\n").slice(0, 20_000),
      `row ${index} holds the text a keyword search matches, path first`,
    );
    assert.equal(row.sectionPath ?? null, expected.chunk.sectionPath ?? null, `row ${index} holds its section path`);
    assert.equal(row.headingPath ?? null, expected.chunk.headingPath ?? null, `row ${index} holds its heading path`);
    assert.equal(row.metadata.repo_path, expected.path, `row ${index} metadata names its path`);
    assert.equal(row.metadata.repo_digest, expected.digest, `row ${index} metadata names its digest`);
    assert.equal(row.metadata.repo_scope_id, scope.id, `row ${index} metadata names its scope`);
    assert.equal(row.metadata.parser, expected.chunk.metadata.parser, `row ${index} keeps the chunker's metadata`);
    assert.equal(row.metadata.block_type, expected.chunk.metadata.block_type, `row ${index} keeps the chunker's block type`);
    assert.ok(row.createdAt instanceof Date && row.updatedAt instanceof Date, `row ${index} is stamped`);

    // The vector: the one the embedder returned, once the column's float4 has rounded it.
    const stored = String(row.embedding).replace(/^\[|\]$/g, "").split(",").map(Number);
    assert.equal(stored.length, EMBEDDING_DIMENSIONS, `row ${index} is stored at the fence's width`);
    const drift = stored.reduce((worst, value, position) => Math.max(worst, Math.abs(value - expected.vector[position])), 0);
    assert.ok(drift < 1e-6, `row ${index} stores the embedder's vector: worst element drift ${drift}`);
  }
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
