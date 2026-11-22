/**
 * The route clients ask for research: POST /v1/oracle/search, over repository content.
 *
 * The query route has answered only what a reader may see since `visibleSourceSql` in
 * `engine/retriever.ts`: a chunk is served when its document is live and its source belongs to a
 * repository scope `isScopeReadable` accepts. The oracle path never carried that rule. It filters
 * `deletedAt` and the source version in its seed query, so an ordinary project answers exactly as
 * the query route does - but a scope that was published and then withdrawn or paused still has all
 * of its rows (retention is the design), and this route kept returning their text. The oracle's
 * document list also omitted `deletedAt`, so the document a stage wrote before its promotion - which
 * carries `deletedAt` precisely so no reader can see it - could be served as if it were published.
 *
 * This file asks the route the way a client asks it, over the same real chain:
 *
 *   api.request("/v1/oracle/search")
 *     -> authMiddleware (the deployment credential)
 *     -> zValidator (the route's own body schema)
 *     -> oracleSearch() -> selectOracleScope() + buildDocumentTree()
 *     -> the route's response mapping
 *
 * The tree is published through the real store, the way a connector publication lands: an attempt
 * opened against the generation the caller observed, one part declaring its paths, and
 * `finalizeAttempt` running the fence and materialising the chunks. The staged case stops between
 * `stageAttempt` and `finalizeAttempt`, which is the state a publication is in before promotion.
 *
 * The chunk text and the query are embedded by the same in-process model (`EMBEDDING_MODE=local`),
 * so "the published text is answered" is a real vector match and nothing calls a provider. Only the
 * per-path vector the fence requires is a deterministic stand-in, because it is not what is being
 * measured.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "RETAINDB_TEST_DATABASE_URL must name a migrated PostgreSQL database: this file publishes real generations and asks the real route, and it skips nothing",
  );
}

/** The deployment credential a client presents. One literal, because it authenticates every call. */
const credential = randomUUID();

const savedEnvironment = { ...process.env };
process.env.DATABASE_URL = databaseUrl;
process.env.RETAINDB_API_KEY = credential;
// `api/agent-tasks.ts` refuses to load without one, and routes.ts mounts it.
process.env.ENCRYPTION_KEY = credential;
// No extraction and no alert mail: this file measures retrieval, and both would be outbound work.
process.env.DISABLE_AUTO_EXTRACTION = "true";
process.env.ALERT_EMAIL_ENABLED = "false";
// Empty on purpose: the oracle must embed the query with the same in-process model the publication
// used, and an OpenAI key would be a second, unmetered answer path this file is not asking about.
process.env.OPENAI_API_KEY = "";
process.env.EMBEDDING_MODE = "local";

/** Every scope and project this file created, removed and counted in `after`. */
const scopeIds: string[] = [];
const projectIds: string[] = [];

const dbPath = "../src/db/index.js";
const storePath = "../src/engine/repo-index/store.js";
const receiptPath = "../src/engine/repo-index/receipt.js";
const embeddingsPath = "../src/engine/embeddings.js";

/** The question a client asks. It matches exactly one path of the published tree. */
const QUERY = "how does the flux capacitor regulate the chronometer";

/** The path that question must answer with, out of every path the tree publishes. */
const TARGET = "docs/chronometer.md";

/**
 * The small tree published for the withdrawal and pause cases: one file the query matches, one
 * source file it does not, and a readme. Three paths rather than one, so "the route returned the
 * published path" is not the only answer a one-file tree could give.
 */
const TREE = [
  {
    path: TARGET,
    content: "# Chronometer\n\nThe flux capacitor regulates the chronometer while the reactor is warm.\n",
  },
  {
    path: "src/reactor.ts",
    content: "export const reactorTemperature = () => 42; // the reactor telemetry probe\n",
  },
  {
    path: "README.md",
    content: "# Fixture repository\n\nA small tree published for the oracle route.\n",
  },
];

/** A sha256 digest: the manifest entry, the path row and the document row carry the same one. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A deterministic vector of the stored width: every element finite, inside [-1, 1] and never
 * exactly zero. It stands in for the connector's digest-derived per-path vector, so nothing here
 * depends on which model the chunk text was embedded with.
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
async function fixture() {
  const { db } = await import(dbPath);
  const client = db as any;
  const name = `oracle-search-${randomUUID()}`;
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
 * Declares one attempt for one tree, against the generation the caller observed: opened with the
 * manifest digest, and its single part naming every path it upserts. Nothing is staged yet.
 */
async function declare(options: {
  scopeId: string;
  baseGeneration: number;
  files: ReadonlyArray<{ path: string; content: string }>;
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
  assert.equal(
    opened.code,
    store.STORE_CODE.ATTEMPT_OPEN,
    `the attempt opens against generation ${options.baseGeneration}: ${opened.code}`,
  );

  const part = await store.putPart({
    scopeId: options.scopeId,
    attemptId,
    partNo: 1,
    part: { upserts: options.files.map((file) => file.path), tombstones: [] },
  });
  assert.equal(part.code, store.STORE_CODE.PART_ACCEPTED, `the one part is accepted: ${part.code}`);

  const contents = new Map(options.files.map((file) => [file.path, file.content] as const));
  return {
    attemptId,
    requiredPaths: options.files.map((file) => file.path),
    manifest: {
      digest: manifestDigest,
      dimensions: EMBEDDING_DIMENSIONS,
      entries: options.files.map((file) => ({
        path: file.path,
        digest: digestOf(file.content),
        vector: pathVector(`fence:${file.path}`, EMBEDDING_DIMENSIONS),
      })),
    },
    readContent: async (path: string) => contents.get(path) ?? "",
    embed,
  };
}

/** Publishes one generation in one call, which is what a connector does, and asserts it published. */
async function publish(options: {
  scopeId: string;
  files: ReadonlyArray<{ path: string; content: string }>;
  baseGeneration?: number;
}) {
  const store = await import(storePath);
  const declared = await declare({
    scopeId: options.scopeId,
    baseGeneration: options.baseGeneration ?? 0,
    files: options.files,
  });
  const published = await store.finalizeAttempt({
    scopeId: options.scopeId,
    attemptId: declared.attemptId,
    requiredPaths: declared.requiredPaths,
    manifest: declared.manifest,
    readContent: declared.readContent,
    embed: declared.embed,
  });
  assert.equal(published.code, "PUBLISHED", `the tree is published: ${JSON.stringify(published)}`);
  return published;
}

/**
 * Stages one attempt and stops there: the two-phase publication a connector uses, halted before the
 * call that promotes the rows. The scope serves the generation it served before, and the documents
 * this wrote carry `deletedAt`, which is what keeps them out of every read path.
 */
async function stage(options: {
  scopeId: string;
  files: ReadonlyArray<{ path: string; content: string }>;
  baseGeneration?: number;
}) {
  const store = await import(storePath);
  const declared = await declare({
    scopeId: options.scopeId,
    baseGeneration: options.baseGeneration ?? 0,
    files: options.files,
  });
  const staged = await store.stageAttempt({
    scopeId: options.scopeId,
    attemptId: declared.attemptId,
    manifest: declared.manifest,
    readContent: declared.readContent,
    embed: declared.embed,
  });
  assert.equal(staged.code, "STAGED", `the attempt stages: ${JSON.stringify(staged)}`);
  return { declared, staged: staged.staged };
}

/** Promotes the stage `stage()` made, in the transaction that fences the attempt. */
async function promote(options: {
  scopeId: string;
  declared: Awaited<ReturnType<typeof declare>>;
  staged: any;
}) {
  const store = await import(storePath);
  return store.finalizeAttempt({
    scopeId: options.scopeId,
    attemptId: options.declared.attemptId,
    requiredPaths: options.declared.requiredPaths,
    manifest: options.declared.manifest,
    readContent: options.declared.readContent,
    embed: options.declared.embed,
    staged: options.staged,
  });
}

/** One client answer, limited to the fields this file reads. */
interface OracleAnswer {
  mode: string;
  query: string;
  results: Array<{ content: string; path: string; relevance: number; metadata: Record<string, any> }>;
  count: number;
  latency_ms: number;
  error?: string;
}

/**
 * The production route, asked the way a client asks it: the deployment credential in the
 * `Authorization` header, the body the route's schema declares, and no in-process shortcut.
 */
async function ask(projectId: string, query: string = QUERY) {
  const { api } = await import("../src/api/routes.js");
  const response = await api.request("/v1/oracle/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ project: projectId, query, max_results: 5 }),
  });
  return { status: response.status, body: (await response.json()) as OracleAnswer };
}

/** The admin state routes, mounted on the same real app and presented the same credential. */
async function admin(scopeId: string, action: "pause" | "resume" | "withdraw") {
  const { api } = await import("../src/api/routes.js");
  const response = await api.request(`/v1/repo-index/admin/scopes/${scopeId}/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  });
  return { status: response.status, body: (await response.json()) as any };
}

/**
 * The published file each answer came from. The oracle reports a result at the path it traversed to
 * the chunk - the document first, then the section and heading it was found under - and
 * materialisation titles a repository document with the path it publishes, so the first node is the
 * path a client can open.
 */
function answeredPaths(answer: OracleAnswer): string[] {
  return answer.results.map((entry) => String(entry.path).split(" > ")[0]);
}

/**
 * The rows a publication leaves in the database: what a withdrawal or pause must not delete. Counted
 * straight from the tables, so "the rows are still there" is measured and not inferred from an
 * answer that happens to be empty.
 */
async function publishedRows(client: any, projectId: string, scopeId: string) {
  return {
    sources: await client.source.count({ where: { projectId } }),
    documents: await client.document.count({ where: { projectId } }),
    chunks: await client.chunk.count({ where: { projectId } }),
    paths: await client.repoIndexPath.count({ where: { scopeId } }),
  };
}

/** The documents a reader may see, and the ones a stage wrote and nobody may: both counted. */
async function documentCounts(client: any, projectId: string) {
  return {
    live: await client.document.count({ where: { projectId, deletedAt: null } }),
    staged: await client.document.count({ where: { projectId, deletedAt: { not: null } } }),
  };
}

/** Every table this file writes to, counted for the rows it created. */
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

// Behaviour: the route answers the published tree, and every answer names a published path. This is
// the control the two invisibility cases below are read against: an empty answer from a withdrawn
// scope only means something if the same route answers the same tree while the scope is active.
test("the oracle route answers the published tree and names the path it came from", { timeout: 180_000 }, async (t) => {
  const { project, scope } = await fixture();
  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.generation, 1, "the first publication is generation 1");

  const answer = await ask(project.id);
  assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 500));
  assert.equal(answer.body.mode, "search");

  const paths = answeredPaths(answer.body);
  assert.ok(paths.includes(TARGET), `the published path is answered: ${JSON.stringify(paths)}`);
  for (const path of paths) {
    assert.ok(TREE.some((file) => file.path === path), `every answer names a path the tree published: ${path}`);
  }

  // The answer that names the target is the target's text, not another file's under its name.
  const target = answer.body.results.find((entry) => entry.path.startsWith(`${TARGET} >`));
  assert.ok(target, `the answer's path names the published file: ${JSON.stringify(paths)}`);
  assert.match(target.content, /flux capacitor/, "the answer carries the text it matched");

  t.diagnostic(`oracle answer paths: ${JSON.stringify(paths)}`);
});

// Behaviour: withdrawing a scope stops the same question from being answered - and does it by
// changing what is readable, not by deleting the tree. Every row the publication wrote is still
// there afterwards, so an empty answer cannot be explained by content that went away.
test("a withdrawn scope answers nothing through the oracle route, and its rows are retained", { timeout: 180_000 }, async (t) => {
  const { client, project, scope } = await fixture();
  await publish({ scopeId: scope.id, files: TREE });

  const active = await ask(project.id);
  assert.ok(answeredPaths(active.body).includes(TARGET), `the active scope answers the published path: ${JSON.stringify(answeredPaths(active.body))}`);

  const retained = await publishedRows(client, project.id, scope.id);
  assert.deepEqual(retained, { sources: 1, documents: 3, chunks: 3, paths: 3 }, "the publication wrote the tree");

  const withdrawal = await admin(scope.id, "withdraw");
  assert.equal(withdrawal.status, 200, JSON.stringify(withdrawal.body));
  assert.equal(withdrawal.body.code, "WITHDRAW_APPLIED");
  assert.equal(withdrawal.body.scope.state, "withdrawn");

  const gone = await ask(project.id);
  assert.equal(gone.status, 200, "a withdrawn scope is an empty answer, not an error");
  assert.deepEqual(gone.body.results, [], "the withdrawn path is not answered, though its rows remain");
  assert.equal(gone.body.count, 0);

  assert.deepEqual(await publishedRows(client, project.id, scope.id), retained,
    "the withdrawal deletes nothing: every row it published is still there");
  assert.equal(
    (await client.repoIndexScope.findUnique({ where: { id: scope.id }, select: { state: true } })).state,
    "withdrawn",
  );

  t.diagnostic(`withdrawn scope ${scope.id}: oracle answers ${gone.body.count} results, ${retained.chunks} chunks retained`);
});

// Behaviour: pausing a scope takes effect immediately on this route too, and resuming puts the same
// tree back - which proves the disappearance was the state and not lost content. Pause changes no
// row at all, so it is purely the read rule that has to refuse it.
test("a paused scope answers nothing through the oracle route, and resumes", { timeout: 180_000 }, async (t) => {
  const { project, scope } = await fixture();
  await publish({ scopeId: scope.id, files: TREE });

  const active = await ask(project.id);
  assert.ok(answeredPaths(active.body).includes(TARGET), "the active scope answers the published path");
  const activeCount = active.body.count;

  const pause = await admin(scope.id, "pause");
  assert.equal(pause.status, 200, JSON.stringify(pause.body));
  assert.equal(pause.body.code, "PAUSE_APPLIED");
  assert.equal(pause.body.scope.state, "paused");

  const gone = await ask(project.id);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.results, [], "a paused scope answers nothing");
  assert.equal(gone.body.count, 0);

  const resume = await admin(scope.id, "resume");
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  assert.equal(resume.body.code, "RESUME_APPLIED");
  assert.equal(resume.body.scope.state, "active");

  const back = await ask(project.id);
  assert.equal(back.body.count, activeCount, "the resumed scope answers the same question again");
  assert.ok(answeredPaths(back.body).includes(TARGET), "and answers it with the path it published");

  t.diagnostic(`paused scope ${scope.id}: oracle answers ${gone.body.count} results, resumes to ${back.body.count}`);
});

// Behaviour: a document a stage wrote is not served before its promotion. Staging is the first half
// of a publication: the rows exist, each carrying `deletedAt`, and promotion clears it in the same
// commit that moves the scope's generation. So before promotion the tree is unpublished, and the
// oracle's document listing must apply the same `deletedAt` rule every chunk query already applies -
// otherwise the text of a generation nobody published is answered as if it were.
test("a staged document is not answered before promotion, and is after", { timeout: 180_000 }, async (t) => {
  const { client, project, scope } = await fixture();
  const stagedPath = "docs/vault.md";
  const stagedContent = "# Vault\n\nThe quokka ledger reconciles the vault against the chronometer every night.\n";

  // Nothing is published: the scope serves generation 0. The tree below is only staged.
  const { declared, staged } = await stage({
    scopeId: scope.id,
    files: [{ path: stagedPath, content: stagedContent }],
  });
  assert.equal(staged.materialise.created, 1, "the stage wrote its one path");
  assert.deepEqual(await documentCounts(client, project.id), { live: 0, staged: 1 },
    "the staged document exists and is not live");

  const before = await ask(project.id, "how does the quokka ledger reconcile the vault");
  assert.equal(before.status, 200, JSON.stringify(before.body).slice(0, 500));
  assert.deepEqual(before.body.results, [], "an unpromoted document is not answered, though its rows exist");
  assert.equal(before.body.count, 0);

  const promoted = await promote({ scopeId: scope.id, declared, staged });
  assert.equal(promoted.code, "PUBLISHED", `the stage promotes: ${JSON.stringify(promoted)}`);
  assert.equal(promoted.generation, 1, "the promotion is the first generation");
  assert.deepEqual(await documentCounts(client, project.id), { live: 1, staged: 0 },
    "the promotion made the staged document live");

  const after = await ask(project.id, "how does the quokka ledger reconcile the vault");
  assert.equal(after.body.count, 1, `the promoted document is answered: ${JSON.stringify(after.body.results)}`);
  assert.deepEqual(answeredPaths(after.body), [stagedPath]);
  assert.match(after.body.results[0].content, /quokka ledger/, "and carries the text it matched");

  t.diagnostic(`staged path answered ${before.body.count} times before promotion, ${after.body.count} after`);
});

after(async () => {
  const { db } = await import(dbPath);
  const client = db as any;
  try {
    // The scope owns its generations, their parts and its paths: one delete takes all of them.
    if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
    // The synthetic source, its documents and their chunks hang off the project.
    if (projectIds.length > 0) await client.project.deleteMany({ where: { id: { in: projectIds } } });

    // Proven empty, not assumed: every table this file wrote to holds none of its rows.
    assert.deepEqual(await countsOf(client), {
      scopes: 0,
      generations: 0,
      parts: 0,
      paths: 0,
      projects: 0,
      sources: 0,
      documents: 0,
      chunks: 0,
    });
  } finally {
    await client.$disconnect();
    process.env = savedEnvironment;
  }
});
