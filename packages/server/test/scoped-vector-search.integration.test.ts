import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";

// Behaviour under test: a scoped vector search answers from the rows the scope holds, never from a
// candidate window that another project filled.
//
// `ORDER BY embedding <=> $query LIMIT k` over a filtered table is answered with an HNSW index scan
// when the planner expects the filter to be expensive. That scan returns only the tuples it visited
// in distance order, and every predicate above it (the project scope, the documents/sources join)
// is applied to that window, so a scope whose rows sit outside the window answers "no matches" for
// a chunk that exists and is visible. The two tests below pin the planner onto that shape and onto
// a walk budget smaller than the competing project, which is the state a large table reaches on its
// own, and require the production entry point to answer with the scoped rows anyway.

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const dimensions = 1024;
const inferenceUrl = "https://scoped-vector-fixture.invalid";
const credential = randomUUID();
const noiseChunks = 200;
const walkBudget = 40;
const originalEnvironment = { ...process.env };

if (databaseUrl) {
  // One connection keeps the session settings below on the connection the route also uses.
  Object.assign(process.env, {
    DATABASE_URL: `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}connection_limit=1`,
    RETAINDB_API_KEY: credential,
    ENCRYPTION_KEY: credential,
    EMBEDDING_MODE: "remote",
    EMBEDDING_INFERENCE_BASE_URL: inferenceUrl,
    REMOTE_INFERENCE_REQUIRED: "true",
    DISABLE_AUTO_EXTRACTION: "true",
    ALERT_EMAIL_ENABLED: "false",
    // Empty on purpose: no query expansion, so the only vector work is the scoped search.
    OPENAI_API_KEY: "",
  });
}

/** Deterministic unit vector, so the fixture's distances are known before the search runs. */
function unitVector(seed: number): number[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const values = Array.from({ length: dimensions }, () => random() * 2 - 1);
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

/** A vector whose cosine similarity to `base` is exactly `similarity`. */
function atSimilarity(base: number[], similarity: number, seed: number): number[] {
  const candidate = unitVector(seed);
  const dot = candidate.reduce((sum, value, index) => sum + value * base[index], 0);
  const orthogonal = candidate.map((value, index) => value - dot * base[index]);
  const norm = Math.hypot(...orthogonal);
  const complement = Math.sqrt(1 - similarity * similarity);
  return base.map((value, index) => similarity * value + complement * (orthogonal[index] / norm));
}

const literal = (values: number[]) => `[${values.join(",")}]`;
const queryVector = unitVector(101);
// The scoped project's own chunks, nearest first. Similarities stay above the query threshold.
const scope = [
  { content: "snapshot retention policy", similarity: 0.8, seed: 202 },
  { content: "checksum verification steps", similarity: 0.7, seed: 303 },
  { content: "restore drill runbook", similarity: 0.6, seed: 404 },
];
const scopeVectors = scope.map((entry) => atSimilarity(queryVector, entry.similarity, entry.seed));

function offlineInference(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    const { inputs } = JSON.parse(String(options?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(() => queryVector) });
  });
}

async function fixture(t: TestContext) {
  offlineInference(t);
  const { db } = await import("../src/db/index.js");
  const name = (prefix: string) => `${prefix}-${randomUUID()}`;
  const scoped = await db.project.create({ data: { name: name("scoped"), slug: name("scoped"), orgId: "default" } });
  const competitor = await db.project.create({ data: { name: name("competitor"), slug: name("competitor"), orgId: "default" } });
  t.after(async () => {
    await db.project.delete({ where: { id: scoped.id } });
    await db.project.delete({ where: { id: competitor.id } });
  });

  const scopedSource = await db.source.create({ data: { projectId: scoped.id, name: "scoped-source", type: "manual" } });
  const scopedDocument = await db.document.create({
    data: { projectId: scoped.id, sourceId: scopedSource.id, externalId: "scoped-doc", title: "scoped-doc" },
  });
  const scopedChunks: Array<{ id: string }> = [];
  for (const [index, entry] of scope.entries()) {
    const chunk = await db.chunk.create({
      data: { projectId: scoped.id, documentId: scopedDocument.id, content: entry.content },
    });
    await db.$executeRaw`UPDATE chunks SET embedding = ${literal(scopeVectors[index])}::vector WHERE id = ${chunk.id}`;
    scopedChunks.push(chunk);
  }

  // The competing project holds vectors identical to the query, so it fills the candidate window.
  const competitorSource = await db.source.create({ data: { projectId: competitor.id, name: "competitor-source", type: "manual" } });
  const competitorDocument = await db.document.create({
    data: { projectId: competitor.id, sourceId: competitorSource.id, externalId: "competitor-doc", title: "competitor-doc" },
  });
  await db.$executeRaw`
    INSERT INTO chunks (id, "documentId", "projectId", content, metadata, embedding, "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${competitorDocument.id}, ${competitor.id}, 'competitor ' || i, '{}'::jsonb,
           ${literal(queryVector)}::vector, now(), now()
    FROM generate_series(1, ${noiseChunks}) i`;
  await db.$executeRawUnsafe("ANALYZE chunks");

  const search = async (body: Record<string, unknown> = {}) => askContext(scoped.id, body);
  return { db, search, scopedChunks };
}

/** The deployment credential every request in this file authenticates with. */
const headers = { "content-type": "application/json", authorization: `Bearer ${credential}` };

/**
 * The production query route, asked the way a client asks it: one project, the vector search only,
 * no cache. `top_k` is 3 so the fixture below keeps its own request; a caller may override it.
 */
async function askContext(projectId: string, body: Record<string, unknown> = {}) {
  const { api } = await import("../src/api/routes.js");
  const response = await api.request("/v1/context/query", {
    method: "POST",
    headers,
    body: JSON.stringify({
      project: projectId,
      query: "snapshot retention",
      hybrid: false,
      use_vector: true,
      rerank: false,
      include_graph: false,
      include_memories: false,
      use_cache: false,
      top_k: 3,
      ...body,
    }),
  });
  return (await response.json()) as { results?: Array<{ id: string; score: number; retrieval_source: string }> };
}

/**
 * Planner state in which the vector index is the only way to order the rows and its walk budget is
 * smaller than the competing project, which is what a table large enough to exhaust the budget
 * reaches on its own: the candidate window then holds none of the scope.
 */
async function pinCandidateWindow(db: any) {
  await db.$executeRawUnsafe("SET enable_seqscan = off");
  await db.$executeRawUnsafe("SET enable_bitmapscan = off");
  await db.$executeRawUnsafe("SET enable_sort = off");
  await db.$executeRawUnsafe(`SET hnsw.max_scan_tuples = ${walkBudget}`);
}

async function unpinCandidateWindow(db: any) {
  await db.$executeRawUnsafe("RESET enable_seqscan");
  await db.$executeRawUnsafe("RESET enable_bitmapscan");
  await db.$executeRawUnsafe("RESET enable_sort");
  await db.$executeRawUnsafe("RESET hnsw.max_scan_tuples");
}

after(() => {
  Object.assign(process.env, originalEnvironment);
});

// Behaviour: the search answers with the chunks the scope holds, in their own order, even while the
// competing project's nearer vectors are the only rows the vector index would walk first.
run("a scoped search returns the chunks in its scope while another project holds nearer vectors", { timeout: 60_000 }, async (t) => {
  const { db, search, scopedChunks } = await fixture(t);
  await pinCandidateWindow(db);
  t.after(async () => {
    await unpinCandidateWindow(db);
  });

  const payload = await search();
  assert.equal(payload.results?.length, 3, "every chunk in scope is answered, not the empty window");
  assert.deepEqual(
    payload.results?.map((hit) => hit.id),
    scopedChunks.map((chunk) => chunk.id),
    "the scope's own order decides the ranking",
  );
  assert.ok(payload.results?.every((hit) => hit.retrieval_source === "vector"), "the hits are the vector search's own");
  assert.ok(payload.results?.every((hit) => hit.score > 0.5), "the scores are the scope's exact distances");
});

// Behaviour: the search owes an answer on a server whose pgvector does not offer the iterative-scan
// setting. An unknown `hnsw.*` name is an unrecognized parameter there, and the statement raises
// inside whatever transaction issues it, so a guard cannot be part of the answer's path.
run("a scoped search answers when the iterative-scan setting is unknown to the connection", { timeout: 60_000 }, async (t) => {
  const { db, search, scopedChunks } = await fixture(t);
  await pinCandidateWindow(db);
  t.after(async () => {
    await unpinCandidateWindow(db);
  });

  // Using the vector type in this session loads pgvector, which reserves the `hnsw` prefix: from
  // then on an hnsw setting this build does not define is rejected instead of being accepted as a
  // placeholder, which is the same trap an older pgvector sets for a guard that names one.
  await db.$queryRawUnsafe(`SELECT '[1,0]'::vector <=> '[1,0]'::vector AS distance`);
  await assert.rejects(
    () => db.$executeRawUnsafe("SET hnsw.iterative_scan_absent = strict_order"),
    (error: any) => {
      // SQLSTATE 42602 with a reserved `hnsw` prefix, 42704 where the name is simply unknown.
      assert.match(String(error?.message), /invalid configuration parameter name|unrecognized configuration parameter/);
      return true;
    },
    "the connection rejects an hnsw setting this pgvector build does not define",
  );

  const payload = await search();
  assert.deepEqual(
    payload.results?.map((hit) => hit.id),
    scopedChunks.map((chunk) => chunk.id),
    "the search answers without depending on that setting",
  );
});

// Behaviour: the exclusion of a repository scope no reader may see belongs INSIDE the scoped set,
// not in the answer after the fact. The withdrawn scope holds the nearest vector in the project, so
// a filter applied after `LIMIT k` would spend the caller's only slot on a row it may not read and
// answer nothing at all; a filter applied before the limit answers the visible row. The withdrawn
// row is counted at the end, because hiding it must not have deleted it.
run("a withdrawn repository scope cannot crowd out the visible answer", { timeout: 60_000 }, async (t) => {
  offlineInference(t);
  const { db } = await import("../src/db/index.js");
  const scopeStore = db as any;
  const name = (prefix: string) => `${prefix}-${randomUUID()}`;
  const project = await db.project.create({ data: { name: name("withdrawn"), slug: name("withdrawn"), orgId: "default" } });
  const scope = await scopeStore.repoIndexScope.create({
    data: {
      projectId: project.id,
      repoHost: "git.example.invalid",
      repoExternalId: name("repo"),
      worktreePath: `/worktrees/${name("worktree")}`,
      deviceId: "device-withdrawn",
      ref: "refs/heads/main",
      headCommit: "0".repeat(40),
      policyVersion: "policy-1",
      pipelineVersion: "pipeline-1",
      state: "withdrawn",
    },
  });
  t.after(async () => {
    // The scope keeps no foreign key to its project, so it is removed by its own id.
    await scopeStore.repoIndexScope.deleteMany({ where: { id: scope.id } });
    await db.project.delete({ where: { id: project.id } });
  });

  // The withdrawn scope's source, document and chunk: the nearest vector in this project.
  const withdrawnSource = await db.source.create({ data: { projectId: project.id, name: `repo-index:${scope.id}`, type: "repo_index" } });
  const withdrawnDocument = await db.document.create({
    data: { projectId: project.id, sourceId: withdrawnSource.id, externalId: "docs/withdrawn.md", title: "docs/withdrawn.md" },
  });
  const withdrawnChunk = await db.chunk.create({
    data: { projectId: project.id, documentId: withdrawnDocument.id, content: "withdrawn snapshot retention note" },
  });
  await db.$executeRaw`UPDATE chunks SET embedding = ${literal(atSimilarity(queryVector, 0.99, 505))}::vector WHERE id = ${withdrawnChunk.id}`;

  // One visible chunk, ranked below it and above the threshold.
  const visibleSource = await db.source.create({ data: { projectId: project.id, name: "visible-source", type: "manual" } });
  const visibleDocument = await db.document.create({
    data: { projectId: project.id, sourceId: visibleSource.id, externalId: "docs/visible.md", title: "docs/visible.md" },
  });
  const visibleChunk = await db.chunk.create({
    data: { projectId: project.id, documentId: visibleDocument.id, content: "visible snapshot retention policy" },
  });
  await db.$executeRaw`UPDATE chunks SET embedding = ${literal(atSimilarity(queryVector, 0.6, 606))}::vector WHERE id = ${visibleChunk.id}`;

  const payload = await askContext(project.id, { top_k: 1, threshold: 0.25 });
  assert.deepEqual(
    payload.results?.map((hit) => hit.id),
    [visibleChunk.id],
    "the one slot the caller asked for is filled from the visible rows",
  );

  assert.equal(
    await db.chunk.count({ where: { projectId: project.id } }),
    2,
    "the withdrawn chunk is still a row, so the answer was filtered and nothing was deleted",
  );
});
