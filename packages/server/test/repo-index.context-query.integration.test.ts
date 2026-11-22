/**
 * The route clients actually ask: POST /v1/context/query, over repository content.
 *
 * Every other test of repository retrieval calls `retrieve()` in process - the function the route
 * happens to call. That is not the contract a client is held to. Claude Code, Codex and Hermes ask
 * the route: they send the deployment credential, a project, a query, and they read a JSON body.
 * Until this file, no repository path had ever been fetched that way, so nothing said whether the
 * answer a client receives names the file it came from, or whether withdrawing or pausing a scope
 * changes what the route answers.
 *
 * The chain under test is the production one, unmodified:
 *
 *   api.request("/v1/context/query")
 *     -> authMiddleware (the deployment credential)
 *     -> zValidator (the route's own body schema)
 *     -> retrieve() (the production search)
 *     -> the route's response mapping
 *
 * The tree is published through the real store (`openAttempt`, `putPart`, `finalizeAttempt`), the
 * way a connector publication lands, and only the chunk embedding is a test seam: a deterministic
 * pseudo-vector, because this file is about what the route answers, not about the model. The query
 * therefore asks the lexical half (`use_vector: false`), which is a real production search path and
 * needs no model; a repo-index publication's vectors are a stand-in here, so a vector query would
 * measure the stand-in.
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
// Empty on purpose: the retriever only expands a query when this is set, and an expansion would be
// a second, unmetered answer path this file is not asking about.
process.env.OPENAI_API_KEY = "";

/** Every scope and project this file created, removed and counted in `after`. */
const scopeIds: string[] = [];
const projectIds: string[] = [];

const dbPath = "../src/db/index.js";
const storePath = "../src/engine/repo-index/store.js";
const receiptPath = "../src/engine/repo-index/receipt.js";

/** The question a client asks. It matches exactly one path of the published tree. */
const QUERY = "flux capacitor regulates the chronometer";

/** The path that question must answer with, out of every path the tree publishes. */
const TARGET = "docs/chronometer.md";

/**
 * The small tree published for every case: one file the query matches, one source file it does
 * not, and a readme. Three paths rather than one, so "the route returned the published path" is
 * not the only answer a one-file tree could give.
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
    content: "# Fixture repository\n\nA small tree published for the context-query route.\n",
  },
];

/** One client answer, limited to the fields this file reads. */
interface ContextAnswer {
  results: Array<{
    id: string;
    content: string;
    score: number;
    metadata: Record<string, any>;
    source?: string;
    document?: string;
    type?: string;
    retrieval_source?: string;
    repository?: { scope_id?: string; path?: string; digest?: string; generation?: number; revision?: number };
  }>;
  context: string;
  meta: { query?: string; total?: number; cache_hit?: boolean; context_hash?: string };
}

/** A sha256 digest: the manifest entry, the path row and the document row carry the same one. */
function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A deterministic vector of the stored width: every element finite, inside [-1, 1] and never
 * exactly zero. It stands in for the connector's digest-derived vector and for a model embedding,
 * so nothing here calls a provider and two runs produce the same value.
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
  const name = `context-query-${randomUUID()}`;
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
 * Publishes one generation through the real publish path: the attempt declares the whole tree
 * against the generation the caller observed, one part declares every path it upserts, and
 * `finalizeAttempt` runs the fence, writes the path rows and materialises the chunks through the
 * production materialiser. The chunk embedding is the deterministic seam described above.
 */
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
 * The production route, asked the way a client asks it: the deployment credential in the
 * `Authorization` header, the body the route's schema declares, and no in-process shortcut.
 * `use_cache` is left at the route's default (true) so the same body can be asked again after a
 * state change, which is what makes the cache a participant in that question.
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
      rerank: false,
      include_memories: false,
      include_graph: false,
      ...overrides,
    }),
  });
  return { status: response.status, body: (await response.json()) as any };
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

/** The rows a publication leaves in the database: what a withdrawal or pause must not delete. */
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
    generations: await client.repoIndexGeneration.count({ where: { scopeId: { in: scopeIds } } }),
    parts: await client.repoIndexPart.count({ where: { generation: { scopeId: { in: scopeIds } } } }),
    paths: await client.repoIndexPath.count({ where: { scopeId: { in: scopeIds } } }),
    projects: await client.project.count({ where: { id: { in: projectIds } } }),
    sources: await client.source.count({ where: { projectId: { in: projectIds } } }),
    documents: await client.document.count({ where: { projectId: { in: projectIds } } }),
    chunks: await client.chunk.count({ where: { projectId: { in: projectIds } } }),
  };
}

// Behaviour: the route returns the published path with the attribution a client needs to say which
// file the answer came from and which publication it belongs to. Path and digest are written by
// materialisation into the chunk metadata; generation and revision belong to the publication, not
// to the chunk, so the route has to carry them. The answer is also what a client packs: one result,
// its text matching, and no other content of the project leaking into it.
test("the route answers a published repository path with its path, digest, generation and revision", { timeout: 180_000 }, async (t) => {
  const { project, scope } = await fixture();
  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.code, "PUBLISHED", `the tree is published: ${JSON.stringify(published)}`);
  assert.equal(published.generation, 1, "the first publication is generation 1");

  const answer = await ask(project.id);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  // One path of the tree matches the question; the other two are published and not returned.
  assert.equal(answer.body.results.length, 1, `the route answers the one matching path: ${JSON.stringify(answer.body.results)}`);
  assert.equal(answer.body.meta.total, 1);
  assert.equal(answer.body.meta.query, QUERY);
  assert.equal(answer.body.meta.cache_hit, false, "the first question is computed, not cached");

  const hit = answer.body.results[0] as ContextAnswer["results"][number];
  assert.equal(hit.document, TARGET, "the hit's document is the published path");
  assert.equal(hit.source, `repo-index:${scope.id}`, "the hit names the scope's own source");
  assert.equal(hit.metadata.repo_scope_id, scope.id);
  assert.equal(hit.metadata.repo_path, TARGET, "the chunk metadata carries the published path");
  assert.equal(hit.metadata.repo_digest, digestOf(TREE[0].content), "and the digest of the blob it was materialised from");
  // The chunk must name the generation that wrote its text. Without this key the route can only label
  // an answer by reading the path row, which a later publication moves - so a hit built from generation
  // 1 would be reported as generation 2. This is what makes the label independent of the path row, and
  // it fails if the key is ever dropped from the chunk metadata again.
  assert.ok(hit.metadata.repo_index_generation_id,
    `the chunk names its own generation: ${JSON.stringify(Object.keys(hit.metadata))}`);
  assert.equal(hit.repository?.generation, 1, "and the reported generation is the first publication");
  assert.ok(hit.content.includes("flux capacitor"), `the answer carries the text it matched: ${hit.content}`);
  assert.match(answer.body.context, /flux capacitor/, "the packed context a client forwards carries the text");

  t.diagnostic(`route hit keys: ${Object.keys(hit).join(", ")}`);
  t.diagnostic(`route hit metadata keys: ${Object.keys(hit.metadata).join(", ")}`);
  t.diagnostic(`route meta keys: ${Object.keys(answer.body.meta).join(", ")}`);

  // The attribution the route added: path, digest, generation and revision in one object, so a
  // client does not have to join a chunk's metadata with a scope lookup of its own.
  assert.deepEqual(hit.repository, {
    scope_id: scope.id,
    path: TARGET,
    digest: digestOf(TREE[0].content),
    generation: 1,
    revision: 1,
  });

  // The same body again is served from the cache the first answer filled - and the attribution is
  // still there, because it is read from the publication rather than stored with the cached rows.
  const warmed = await ask(project.id);
  assert.equal(warmed.status, 200);
  assert.equal(warmed.body.meta.cache_hit, true, "the same body is answered from the cache it filled");
  assert.deepEqual(warmed.body.results[0].repository, hit.repository, "a cached answer still carries the publication it came from");
});

// Behaviour: the route is authenticated like every other one in this build. A caller without the
// deployment credential is refused before validation or retrieval, and a caller with it but an
// empty query reaches the route's schema and is refused there. These are the two error answers a
// client has to handle before it can consume a single result.
/**
 * Behaviour: the route's DEFAULT request must answer. The schema declares use_vector defaulting to
 * true, so a client that says nothing about vectors is asking for them - and every other case in this
 * file happens to pass use_vector:false, which is why the default was never exercised. With no
 * embedder available in this environment, the default used to raise an opaque 500 ("Internal Server
 * Error", not even JSON). It must instead answer from the lexical half and say the answer is partial,
 * because a client that cannot tell a partial answer from a complete one will trust it.
 */
test("the default request answers without an embedder and says the answer is partial", { timeout: 180_000 }, async () => {
  const { project, scope } = await fixture();
  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.code, "PUBLISHED", `the tree is published: ${JSON.stringify(published)}`);

  // Built here rather than through ask(): ask() hardcodes use_vector:false, which is exactly how the
  // default escaped notice. This body omits the field, which is what a client sends.
  const { api } = await import("../src/api/routes.js");
  const response = await api.request("/v1/context/query", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    // include_graph and include_memories both need an embedding too: a client that asks for
    // everything must not be turned into a 500 by an embedder it did not ask about.
    body: JSON.stringify({
      project: project.id,
      query: QUERY,
      top_k: 5,
      threshold: 0,
      use_cache: false,
      rerank: false,
      include_memories: true,
      include_graph: true,
    }),
  });
  const answer = { status: response.status, body: (await response.json()) as any };
  assert.equal(answer.status, 200, `the default request is answered, not a 500: ${JSON.stringify(answer.body).slice(0, 300)}`);
  assert.ok(Array.isArray(answer.body.results), "the response is the documented shape");

  // The embedder is unavailable here, so the answer must be marked partial rather than silently short.
  assert.equal(answer.body.meta?.timing?.embedding_unavailable, true,
    `the answer says the vector half was skipped: ${JSON.stringify(answer.body.meta?.timing)}`);
});

/**
 * Behaviour: a partial answer is not stored, so it can never be served as a complete one.
 *
 * The same body asked twice is one cache key. The first answer is computed while the embedder is
 * unavailable, so it is the lexical half and it says so. If that answer were stored, the second
 * request - the same question, a second later, or four minutes later - would be answered from it:
 * `cache_hit: true`, no `embedding_unavailable`, and a client with no way to tell that half the
 * answer was never looked for. A cached answer cannot be re-checked, so the only honest thing to
 * store is a complete one.
 */
test("a partial answer is not cached, so the same question is answered partial again", { timeout: 180_000 }, async (t) => {
  const { project, scope } = await fixture();
  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.code, "PUBLISHED", `the tree is published: ${JSON.stringify(published)}`);

  // `use_vector: undefined` drops the key from the JSON body, which is how a client asks for the
  // default - and the default is `true`, the only shape that reaches the embedder. `include_memories`
  // is what makes the answer lose a second, requested half rather than just the vector search.
  const partial = { use_vector: undefined, include_memories: true, rerank: false };

  const first = await ask(project.id, partial);
  assert.equal(first.status, 200, `the partial answer is an answer, not a 500: ${JSON.stringify(first.body).slice(0, 300)}`);
  assert.equal(first.body.results.length, 1, `the lexical half answers the question: ${JSON.stringify(first.body.results)}`);
  assert.equal(first.body.meta.cache_hit, false, "the first question is computed, not cached");
  assert.equal(first.body.meta.timing?.embedding_unavailable, true,
    `the first answer says the vector half was skipped: ${JSON.stringify(first.body.meta?.timing)}`);
  assert.equal(first.body.meta.timing?.memory_skipped, true,
    `and that the memories it asked for were not searched: ${JSON.stringify(first.body.meta?.timing)}`);

  // The same body again, with the cache on. Whether this is recomputed or served from a stored
  // answer, what comes back must carry the same disclosure: a hit that presents the partial answer
  // as complete is the defect. `cache_hit: false` is the shape chosen here - a partial answer is
  // never stored - so the second question recomputes and cannot outlive the outage either.
  const second = await ask(project.id, partial);
  assert.equal(second.status, 200, `the second question is answered too: ${JSON.stringify(second.body).slice(0, 300)}`);
  assert.equal(second.body.meta.timing?.embedding_unavailable, true,
    `the second answer still says the vector half was skipped: ${JSON.stringify(second.body.meta)}`);
  assert.equal(second.body.meta.timing?.memory_skipped, true,
    `and still says the memories were not searched: ${JSON.stringify(second.body.meta?.timing)}`);
  assert.equal(second.body.meta.cache_hit, false, "a partial answer was not stored, so there is nothing to hit");
  assert.equal(second.body.results.length, 1, "and it answers from the lexical half, not from an empty cache entry");

  t.diagnostic(`partial answer twice: cache_hit ${first.body.meta.cache_hit} then ${second.body.meta.cache_hit}`);
});

/**
 * Behaviour: an answer that lost nothing is still cached. The fix for the case above is not allowed
 * to be "stop caching when anything is missing" - a global off switch, or a flag that is always on,
 * would pass that case while quietly deleting the cache for every client. This shape asks for no
 * vectors at all, so no embedding is attempted and the answer is missing nothing.
 */
test("an answer that lost nothing is still cached", { timeout: 180_000 }, async (t) => {
  const { project, scope } = await fixture();
  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.code, "PUBLISHED", `the tree is published: ${JSON.stringify(published)}`);

  const first = await ask(project.id);
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  assert.equal(first.body.meta.cache_hit, false, "the first question is computed");
  assert.equal(first.body.meta.timing?.embedding_unavailable, undefined,
    `an answer that asked for no vectors is not degraded: ${JSON.stringify(first.body.meta?.timing)}`);
  assert.equal(first.body.meta.timing?.memory_skipped, undefined,
    `and it skipped nothing it was asked for: ${JSON.stringify(first.body.meta?.timing)}`);

  const second = await ask(project.id);
  assert.equal(second.body.meta.cache_hit, true, "a complete answer fills the cache");
  assert.equal(second.body.meta.timing?.embedding_unavailable, undefined,
    "and the cached answer is not degraded either");
  assert.equal(second.body.results.length, 1, "the hit answers with the content the first answer found");

  t.diagnostic(`complete answer twice: cache_hit ${first.body.meta.cache_hit} then ${second.body.meta.cache_hit}`);
});

test("the query route refuses a caller without the credential and a body its schema rejects", { timeout: 180_000 }, async () => {
  const { api } = await import("../src/api/routes.js");
  const body = JSON.stringify({ project: randomUUID(), query: QUERY, use_vector: false, rerank: false });

  const anonymous = await api.request("/v1/context/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(anonymous.status, 401, JSON.stringify(await anonymous.clone().json()));
  assert.equal(typeof ((await anonymous.json()) as any).error, "string", "the refusal is an error string a client can log");

  const empty = await api.request("/v1/context/query", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ project: randomUUID(), query: "", use_vector: false, rerank: false }),
  });
  assert.equal(empty.status, 400, "the route's own schema rejects an empty query");
});

// Behaviour: an answer that is not repository content keeps exactly the shape it had. The route
// attaches `repository` only when a result names a scope and a path, so an ordinary document hit
// carries no new key at all - the additive half of the contract existing clients depend on.
test("an ordinary document answer carries no repository field", { timeout: 180_000 }, async () => {
  const { db } = await import(dbPath);
  const client = db as any;
  const name = `context-query-plain-${randomUUID()}`;
  const project = await client.project.create({ data: { name, slug: name, orgId: "default" } });
  projectIds.push(project.id);
  const source = await client.source.create({ data: { projectId: project.id, name: "handbook-source", type: "manual" } });
  const document = await client.document.create({
    data: { projectId: project.id, sourceId: source.id, externalId: "handbook", title: "Handbook" },
  });
  await client.chunk.create({
    data: {
      projectId: project.id,
      documentId: document.id,
      content: "The onboarding checklist is signed by the team lead before the first week ends.",
    },
  });

  const answer = await ask(project.id, { query: "onboarding checklist signed team lead" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.results.length, 1, "the ordinary document answers the question");
  assert.equal(answer.body.results[0].document, "Handbook");
  assert.equal(Object.hasOwn(answer.body.results[0], "repository"), false, "no repository key is added to non-repository content");
});

// Behaviour: withdrawing a scope stops the same question, asked the same way, from being answered -
// and does it by changing what is readable, not by deleting the tree. The answer cached while the
// scope was active must not outlive the withdrawal: if it did, a client would keep receiving the
// withdrawn path for the cache's full TTL. Every row the publication wrote is still there after.
test("a withdrawn scope stops answering through the route, and its rows are retained", { timeout: 180_000 }, async (t) => {
  const { client, project, scope } = await fixture();
  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.code, "PUBLISHED");

  const active = await ask(project.id);
  assert.equal(active.body.results.length, 1, "the active scope answers the question");
  assert.equal(active.body.meta.cache_hit, false);
  const warmed = await ask(project.id);
  assert.equal(warmed.body.meta.cache_hit, true, "and the answer is cached under the body that asked");

  const retained = await publishedRows(client, project.id, scope.id);
  assert.deepEqual(retained, { sources: 1, documents: 3, chunks: 3, paths: 3 }, "the publication wrote the tree");

  const withdrawal = await admin(scope.id, "withdraw");
  assert.equal(withdrawal.status, 200, JSON.stringify(withdrawal.body));
  assert.equal(withdrawal.body.code, "WITHDRAW_APPLIED");
  assert.equal(withdrawal.body.scope.state, "withdrawn");

  const gone = await ask(project.id);
  assert.equal(gone.status, 200, "a withdrawn scope is an empty answer, not an error");
  assert.deepEqual(gone.body.results, [], "the withdrawn path is not answered, though its rows remain");
  assert.equal(gone.body.context, "", "and the packed context a client forwards is empty too");
  assert.equal(gone.body.meta.total, 0);
  assert.equal(gone.body.meta.cache_hit, false, "the answer cached before the withdrawal is gone");

  const uncached = await ask(project.id, { use_cache: false });
  assert.deepEqual(uncached.body.results, [], "the read filter refuses a withdrawn scope even without a cache");

  assert.deepEqual(await publishedRows(client, project.id, scope.id), retained, "the withdrawal deletes nothing: every row it published is still there");
  assert.equal((await client.repoIndexScope.findUnique({ where: { id: scope.id }, select: { state: true } })).state, "withdrawn");

  t.diagnostic(`withdrawn scope ${scope.id}: route answers ${gone.body.results.length} results, ${retained.chunks} chunks retained`);
});

// Behaviour: pausing a scope takes effect immediately on the route, including for an answer that
// was cached while it was active. Pause changes no row - only the state the read path consults - so
// a cache that was not cleared would keep serving the paused tree for its full TTL. Resuming puts
// the same tree back, which proves the disappearance was the state and not lost content.
test("a paused scope stops answering through the route, cached or not, and resumes", { timeout: 180_000 }, async (t) => {
  const { project, scope } = await fixture();
  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.code, "PUBLISHED");

  const active = await ask(project.id);
  assert.equal(active.body.results.length, 1);
  assert.equal(active.body.results[0].metadata.repo_path, TARGET);
  const warmed = await ask(project.id);
  assert.equal(warmed.body.meta.cache_hit, true, "the active answer is cached");

  const pause = await admin(scope.id, "pause");
  assert.equal(pause.status, 200, JSON.stringify(pause.body));
  assert.equal(pause.body.code, "PAUSE_APPLIED");
  assert.equal(pause.body.scope.state, "paused");

  const gone = await ask(project.id);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.results, [], "a paused scope serves nothing, cached or not");
  assert.equal(gone.body.context, "");
  assert.equal(gone.body.meta.cache_hit, false, "the answer cached before the pause is gone");

  const uncached = await ask(project.id, { use_cache: false });
  assert.deepEqual(uncached.body.results, [], "the read path refuses a paused scope, so not even an uncached question answers");

  const resume = await admin(scope.id, "resume");
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  assert.equal(resume.body.code, "RESUME_APPLIED");
  assert.equal(resume.body.scope.state, "active");

  const back = await ask(project.id);
  assert.equal(back.body.results.length, 1, "the resumed scope answers the same question again");
  assert.equal(back.body.results[0].metadata.repo_path, TARGET);
  assert.equal(back.body.meta.cache_hit, false, "the answer is computed under the resumed state");

  t.diagnostic(`paused scope ${scope.id}: route answers ${gone.body.results.length} results, resumes to ${back.body.results.length}`);
});

// Behaviour: resume puts repository content back into the answer the project asks next. The answer
// computed while the scope was paused is not empty here - the project's handbook still answers - so
// it is the cached one (engine/retriever.ts stores an answer only when it has at least one result,
// which is why the empty paused answer above can never show this defect). Resume decides that the
// repository is readable again, so an answer cached under the paused state must go; otherwise the
// repository stays missing from the same question for the cache's full five minutes.
test("a resumed scope answers its content again instead of the answer cached while it was paused", { timeout: 180_000 }, async () => {
  const { client, project, scope } = await fixture();
  // An ordinary handbook document of the same project, answering the same question: what makes the
  // paused answer non-empty, and therefore cached. The name is unique because a source is unique
  // per org and name, and the sibling test above owns `handbook-source`.
  const handbook = `handbook-${randomUUID()}`;
  const source = await client.source.create({ data: { projectId: project.id, name: handbook, type: "manual" } });
  const document = await client.document.create({
    data: { projectId: project.id, sourceId: source.id, externalId: handbook, title: "Handbook" },
  });
  await client.chunk.create({
    data: {
      projectId: project.id,
      documentId: document.id,
      content: "The handbook records that the flux capacitor regulates the chronometer during every service visit.",
    },
  });

  const published = await publish({ scopeId: scope.id, files: TREE });
  assert.equal(published.code, "PUBLISHED", `the tree is published: ${JSON.stringify(published)}`);

  const active = await ask(project.id);
  assert.equal(active.body.results.length, 2, `the handbook and the repository path both answer while the scope is active: ${JSON.stringify(active.body.results)}`);
  assert.equal(active.body.results.some((hit: any) => hit.metadata?.repo_path === TARGET), true, "the active answer names the published path");

  const pause = await admin(scope.id, "pause");
  assert.equal(pause.status, 200, JSON.stringify(pause.body));
  assert.equal(pause.body.code, "PAUSE_APPLIED");

  const paused = await ask(project.id);
  assert.equal(paused.body.results.length, 1, "the handbook is the whole answer while the scope is paused");
  assert.equal(paused.body.results[0].document, "Handbook");
  assert.equal(paused.body.meta.cache_hit, false, "the paused answer is computed, because the pause cleared the active one");
  const pausedAgain = await ask(project.id);
  assert.equal(pausedAgain.body.meta.cache_hit, true, "the non-empty paused answer is cached under the body that asked");

  const resume = await admin(scope.id, "resume");
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  assert.equal(resume.body.code, "RESUME_APPLIED");

  const back = await ask(project.id);
  assert.equal(back.body.meta.cache_hit, false, "the answer cached before the resume is gone");
  assert.equal(back.body.results.length, 2, `the resumed scope answers alongside the handbook: ${JSON.stringify(back.body.results)}`);
  assert.equal(back.body.results.some((hit: any) => hit.metadata?.repo_path === TARGET), true, "the repository path is answered again");
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
