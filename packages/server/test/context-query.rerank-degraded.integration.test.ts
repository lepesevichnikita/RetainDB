/**
 * What a client is told when the reranker is unavailable, and what it is not told later.
 *
 * The retriever answers from the fused order when the reranker cannot be consulted, and it computes
 * `meta.degraded` for exactly that: which half was skipped and why. Two things went wrong with it.
 * The route that answers clients listed its meta keys one by one and never copied `degraded`, so the
 * degradation the retriever knew about reached nobody; and the answer was stored, so the next
 * identical question was answered from an entry that presents a degraded answer as a complete one -
 * for the whole TTL, and after the reranker had recovered.
 *
 * This is the reranker's half of the rule the embedder already has ("a partial answer is not
 * cached"): a degraded answer is answered fresh every time and says so every time, and an answer
 * that lost nothing is still cached.
 *
 * The chain is the production one: `api.request("/v1/context/query")` -> authMiddleware ->
 * zValidator -> `retrieve()` -> the route's response mapping. The content is published through the
 * real store; only the chunk embedding is a deterministic seam, and the query asks the lexical half
 * (`use_vector: false`), so no model is called for the search itself.
 *
 * The failure is the real one for the configuration below: this deployment requires the remote
 * reranker (`REMOTE_INFERENCE_REQUIRED`), and no rerank URL is configured, so the client that would
 * call it throws instead of reaching the network. That is the same exception a deployed service
 * without a reachable reranker raises, and it is what `applyRerank` converts into a degraded answer.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "RETAINDB_TEST_DATABASE_URL must name a migrated PostgreSQL database: this file publishes a real generation and asks the real route, and it skips nothing",
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
// Empty on purpose: the retriever only expands a query when this is set, and an expansion is a
// second answer path this file is not asking about.
process.env.OPENAI_API_KEY = "";
// The reranker this deployment requires is the remote one, and it has no URL: every rerank attempt
// throws immediately, which is the degradation under test. It must be set before the retriever is
// imported, because the module reads these once.
process.env.RERANK_PROVIDER = "remote";
process.env.REMOTE_INFERENCE_REQUIRED = "true";
delete process.env.RERANK_INFERENCE_BASE_URL;
delete process.env.RERANK_BASE_URL;
delete process.env.INFERENCE_BASE_URL;
delete process.env.INFERENCE_API_URL;

/** Every scope and project this file created, removed and counted in `after`. */
const scopeIds: string[] = [];
const projectIds: string[] = [];

const dbPath = "../src/db/index.js";
const storePath = "../src/engine/repo-index/store.js";
const receiptPath = "../src/engine/repo-index/receipt.js";

/** The question, matched by every path of the tree: the reranker is only consulted above three. */
const QUERY = "chronometer calibration";

/**
 * A tree of four files, each holding the question's words. Four rather than one because
 * `rerankResults` ignores a candidate set of three or fewer - it is not worth reordering - so a
 * smaller tree would never reach the reranker, and the degradation under test would never happen.
 */
const TREE = [
  { path: "docs/chronometer.md", content: "# Chronometer\n\nThe chronometer calibration is due every spring.\n" },
  { path: "src/clock.ts", content: "export const calibrationInterval = 42; // chronometer calibration, in days\n" },
  { path: "docs/calibration.md", content: "# Calibration\n\nRun the chronometer calibration before shipping.\n" },
  { path: "README.md", content: "# Fixture repository\n\nA small tree whose chronometer calibration notes match the question.\n" },
];

/** One client answer, limited to the fields this file reads. */
interface ContextAnswer {
  results: Array<{ id: string; content: string }>;
  context: string;
  meta: {
    total?: number;
    cache_hit?: boolean;
    degraded?: { reranked: boolean; reasons: string[] };
  };
}

/** A sha256 digest: the manifest entry, the path row and the document row carry the same one. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A deterministic vector of the stored width: every element finite, inside [-1, 1] and never exactly
 * zero. It stands in for a model embedding so nothing here calls a provider, and two runs produce
 * the same value.
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

/** One project and one active repository scope inside it, both removed in `after`. */
async function fixture() {
  const { db } = await import(dbPath);
  const client = db as any;
  const name = `rerank-degraded-${randomUUID()}`;
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

/** Publishes the tree through the real publish path, the way a connector publication lands. */
async function publish(options: { scopeId: string; files: ReadonlyArray<{ path: string; content: string }> }) {
  const store = await import(storePath);
  const { EMBEDDING_DIMENSIONS } = await import(receiptPath);
  const attemptId = randomUUID();
  const manifestDigest = digestOf(options.files.map((file) => `${file.path}\n${digestOf(file.content)}`).join("\n"));

  const opened = await store.openAttempt({
    scopeId: options.scopeId,
    attemptId,
    baseGeneration: 0,
    revision: 1,
    manifestDigest,
    partCount: 1,
  });
  assert.equal(opened.code, store.STORE_CODE.ATTEMPT_OPEN, `the attempt opens against generation 0: ${opened.code}`);

  const part = await store.putPart({
    scopeId: options.scopeId,
    attemptId,
    partNo: 1,
    part: { upserts: options.files.map((file) => file.path), tombstones: [] },
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
        vector: pseudoVector(`fence:${file.path}`, EMBEDDING_DIMENSIONS),
      })),
    },
    readContent: async (path: string) => contents.get(path) ?? "",
    embed: async (texts: string[]) => texts.map((text) => pseudoVector(`chunk:${text}`, EMBEDDING_DIMENSIONS)),
  });
}

/**
 * The production route, asked the way a client asks it. `rerank` defaults to true here - the route's
 * own default - because the reranker is the subject; `use_cache` stays at the route's default too,
 * which is what makes the cache a participant in the question.
 */
async function ask(projectId: string, overrides: Record<string, unknown> = {}) {
  const { api } = await import("../src/api/routes.js");
  const response = await api.request("/v1/context/query", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({
      project: projectId,
      query: QUERY,
      top_k: 5,
      threshold: 0,
      hybrid: true,
      use_vector: false,
      include_memories: false,
      include_graph: false,
      ...overrides,
    }),
  });
  return { status: response.status, body: (await response.json()) as ContextAnswer & { meta: any } };
}

// Behaviour: an answer that lost its reranking is reported as degraded, and is not stored. Both
// halves matter and both are observable from the route: the client that receives the answer is told
// the fused order is what it got, and the client that asks again is recomputed rather than served a
// stored answer that claims to be complete.
test("a rerank-degraded answer says so and is not cached", { timeout: 180_000 }, async (t) => {
  const { project, scope } = await fixture();
  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.code, "PUBLISHED", `the tree is published: ${JSON.stringify(published)}`);

  const first = await ask(project.id);
  assert.equal(first.status, 200, `a reranker outage is an answer, not a 500: ${JSON.stringify(first.body).slice(0, 300)}`);
  assert.ok(
    first.body.results.length > 3,
    `the reranker was consulted, which needs more than three candidates: ${JSON.stringify(first.body.results)}`,
  );
  assert.deepEqual(
    first.body.meta.degraded,
    { reranked: false, reasons: ["reranker_unavailable"] },
    `the answer names the half it could not consult: ${JSON.stringify(first.body.meta)}`,
  );
  assert.equal(first.body.meta.cache_hit, false, "the first question is computed");

  // The same question again. It must be recomputed, and it must disclose the same degradation: a
  // stored entry could not be re-checked, so it would keep presenting a degraded answer as complete
  // for its whole TTL - including after the reranker came back.
  const second = await ask(project.id);
  assert.equal(second.body.meta.cache_hit, false, "a degraded answer was not stored, so there is nothing to hit");
  assert.deepEqual(
    second.body.meta.degraded,
    { reranked: false, reasons: ["reranker_unavailable"] },
    `the second answer discloses it too: ${JSON.stringify(second.body.meta)}`,
  );
  assert.deepEqual(
    second.body.results.map((hit) => hit.id),
    first.body.results.map((hit) => hit.id),
    "and it answers the same fused order, not an empty cache entry",
  );

  t.diagnostic(`degraded answer twice: cache_hit ${first.body.meta.cache_hit} then ${second.body.meta.cache_hit}`);

  // The rule is not "stop caching": an answer that lost nothing is still stored. This shape asks
  // the same question with the reranker out of the path, so nothing is degraded.
  const complete = await ask(project.id, { rerank: false });
  assert.equal(complete.body.meta.cache_hit, false, "the first complete question is computed");
  assert.deepEqual(
    complete.body.meta.degraded,
    { reranked: true, reasons: [] },
    `an answer that lost nothing says so, rather than omitting the field: ${JSON.stringify(complete.body.meta)}`,
  );

  const cached = await ask(project.id, { rerank: false });
  assert.equal(cached.body.meta.cache_hit, true, "a complete answer is still cached");
  assert.deepEqual(
    cached.body.meta.degraded,
    { reranked: true, reasons: [] },
    "and a cache hit never hides a degradation",
  );
  assert.deepEqual(
    cached.body.results.map((hit) => hit.id),
    complete.body.results.map((hit) => hit.id),
    "the hit answers with the content the first complete answer found",
  );

  t.diagnostic(`complete answer twice: cache_hit ${complete.body.meta.cache_hit} then ${cached.body.meta.cache_hit}`);
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
    assert.deepEqual(
      {
        scopes: await client.repoIndexScope.count({ where: { id: { in: scopeIds } } }),
        sources: await client.source.count({ where: { projectId: { in: projectIds } } }),
        documents: await client.document.count({ where: { projectId: { in: projectIds } } }),
        chunks: await client.chunk.count({ where: { projectId: { in: projectIds } } }),
        projects: await client.project.count({ where: { id: { in: projectIds } } }),
      },
      { scopes: 0, sources: 0, documents: 0, chunks: 0, projects: 0 },
      "this file left no row behind",
    );
  } finally {
    await client.$disconnect();
    process.env = savedEnvironment;
  }
});
