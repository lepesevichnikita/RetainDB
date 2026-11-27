import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const vector = [1, ...Array<number>(1023).fill(0)];
const queryEmbeddingModel = "graph-fixture-model";
const inferenceUrl = "https://graph-fixture.invalid";
const credential = randomUUID();
const originalEnvironment = { ...process.env };

if (databaseUrl) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    RETAINDB_API_KEY: credential,
    ENCRYPTION_KEY: credential,
    EMBEDDING_MODE: "remote",
    EMBEDDING_INFERENCE_BASE_URL: inferenceUrl,
    REMOTE_INFERENCE_REQUIRED: "true",
    DISABLE_AUTO_EXTRACTION: "false",
    ALERT_EMAIL_ENABLED: "false",
    OPENAI_API_KEY: "synthetic-graph-fixture",
  });
}

const extraction = {
  entities: [
    { name: "Snapshot", type: "concept", description: "A database snapshot" },
    { name: "Checksum", type: "concept", description: "A verification checksum" },
  ],
  relations: [
    { from: "Snapshot", fromType: "concept", to: "Checksum", toType: "concept", relation: "references" },
  ],
};

function offlineInference(t: TestContext, claims: () => unknown) {
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async () => ({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(claims()) } }],
  }));
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    const { inputs } = JSON.parse(String(options?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(() => vector), model: queryEmbeddingModel });
  });
}

async function fixture(t: TestContext, claims: () => unknown = () => extraction) {
  offlineInference(t, claims);
  const { db } = await import("../src/db/index.js");
  const { api } = await import("../src/api/routes.js");
  const name = `graph-${randomUUID()}`;
  const project = await db.project.create({ data: { name, slug: name, orgId: "default" } });
  t.after(async () => { await db.project.delete({ where: { id: project.id } }); });
  const headers = { "content-type": "application/json", authorization: `Bearer ${credential}` };
  const post = async (path: string, body: Record<string, unknown>, status = 200) => {
    const response = await api.request(path, {
      method: "POST", headers,
      body: JSON.stringify({ project: project.id, ...body }),
    });
    const text = await response.text();
    assert.equal(response.status, status, text);
    return JSON.parse(text);
  };
  const get = (path: string) => {
    const url = new URL(path, "http://localhost");
    url.searchParams.set("project", project.id);
    return api.request(url, { headers });
  };
  return { db, project, post, get };
}

type GraphFixture = Awaited<ReturnType<typeof fixture>>;

type GraphResponse = {
  entities: { id: string; name: string; description: string | null; score: number }[];
  relations: { id: string; fromEntityId: string; toEntityId: string; relationType: string }[];
};

async function seedEntity({ db, project }: GraphFixture, name: string, sourceChunkId?: string, seed = false) {
  const id = randomUUID();
  const embedding = seed ? `[${vector.join(",")}]` : null;
  await db.$executeRaw`
    INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", origin, embedding, "updatedAt")
    VALUES (${id}, ${project.id}, ${name}, 'concept', 'concept', ${sourceChunkId === undefined},
      ${sourceChunkId === undefined ? "manual" : "extracted"}, ${sourceChunkId === undefined ? embedding : null}::vector, NOW())
  `;
  if (sourceChunkId) await db.$executeRaw`
    INSERT INTO entity_mentions ("entityId", "chunkId", embedding) VALUES (${id}, ${sourceChunkId}, ${embedding}::vector)
  `;
  return id;
}

async function seedSource({ db, project }: GraphFixture, name: string) {
  return db.source.create({ data: { projectId: project.id, name, type: "text", status: "READY" } });
}

/** The extraction context the ingest path supplies: claims are anchored to this chunk's own content. */
function extractionSource(sourceId: string, chunk: { documentId: string }, text: string, sourceVersionId: string | null = null) {
  return { sourceId, sourceVersionId, documentId: chunk.documentId, contentDigest: createHash("sha256").update(text).digest("hex") };
}

async function seedChunk({ db, project }: GraphFixture, sourceId: string, title: string, sourceVersionId?: string, embedding?: readonly number[]) {
  const document = await db.document.create({ data: { sourceId, projectId: project.id, title, sourceVersionId, status: "READY" } });
  const chunk = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, chunkType: "text", content: title } });
  if (embedding) await db.$executeRaw`UPDATE chunks SET embedding = ${`[${embedding.join(",")}]`}::vector WHERE id = ${chunk.id}`;
  return chunk;
}

run("graph writes reuse entity IDs and keep a structural endpoint searchable by name", { timeout: 25_000 }, async (t) => {
  const { db, post } = await fixture(t);
  const request = { name: "Snapshot", entity_type: "concept", description: "First snapshot" };
  const created = await post("/v1/entities", request, 201);
  const updated = await post("/v1/entities", { name: "Snapshot", entity_type: "concept", metadata: { rank: 1 } }, 201);
  assert.equal(updated.id, created.id);
  assert.equal(updated.description, "First snapshot");
  assert.deepEqual(updated.metadata, { rank: 1 });

  const edge = {
    from_entity: "Snapshot", from_type: "concept",
    to_entity: "Checksum", to_type: "concept", relation_type: "references",
  };
  const relation = await post("/v1/relations", edge, 201);
  const repeated = await post("/v1/relations", { ...edge, weight: 0.6 }, 201);
  assert.equal(repeated.id, relation.id);
  assert.equal(repeated.fromEntityId, created.id);
  assert.equal(repeated.weight, 0.6);

  // With no source chunk, the endpoint is structural and has no separate vector.
  const [target] = await db.$queryRaw<{ type: string; dimensions: number | null }[]>`
    SELECT type, vector_dims(embedding) AS dimensions FROM entities WHERE id = ${repeated.toEntityId}
  `;
  assert.deepEqual(target, { type: "concept", dimensions: null });
  const found: GraphResponse = await post("/v1/graph/search", { query: "checksum", top_k: 1 });
  assert.equal(found.entities[0]?.id, repeated.toEntityId);
  // Traversal is directed, so an edge pointing into the matched node is not followed from here.
  assert.deepEqual(found.relations, []);
  const fromSource: GraphResponse = await post("/v1/graph/search", { query: "snapshot", top_k: 1 });
  assert.deepEqual(fromSource.relations.map(({ id }) => id), [repeated.id]);
});

run("graph search without a project returns the organization's labeled graph", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, project, post } = graph;
  const sibling = `${project.name}-sibling`;
  const foreign = `${project.name}-foreign`;
  await db.$executeRaw`INSERT INTO users (id, email, "updatedAt") VALUES (${foreign}, ${`${foreign}@example.test`}, NOW())`;
  await db.$executeRaw`INSERT INTO organizations (id, name, slug, "ownerId", "updatedAt") VALUES (${foreign}, ${foreign}, ${foreign}, ${foreign}, NOW())`;
  const outside = await db.project.create({ data: { name: foreign, slug: foreign, orgId: foreign } });
  t.after(async () => {
    await db.project.deleteMany({ where: { OR: [{ id: outside.id }, { name: sibling, orgId: "default" }] } });
    await db.$executeRaw`DELETE FROM organizations WHERE id = ${foreign}`;
    await db.$executeRaw`DELETE FROM users WHERE id = ${foreign}`;
  });

  // The foreign seed matches the query exactly, just like the two authorized seeds.
  await seedEntity({ db, project: outside } as GraphFixture, project.name, undefined, true);
  const edges: GraphResponse["relations"] = [];
  for (const ref of [project.id, sibling]) {
    edges.push(await post("/v1/relations", {
      project: ref, from_entity: project.name, from_type: "concept", to_entity: `${ref}-endpoint`,
      to_type: "concept", relation_type: "references",
    }, 201));
  }
  // A mismatched stored claim must not change another project's entity description.
  const siblingProject = await db.project.findFirstOrThrow({ where: { name: sibling, orgId: project.orgId } });
  const siblingGraph = { ...graph, project: siblingProject };
  const source = await seedSource(siblingGraph, "Sibling claim source");
  const chunk = await seedChunk(siblingGraph, source.id, "Sibling claim chunk");
  await db.$executeRaw`INSERT INTO entity_mentions ("entityId", "chunkId", description)
    VALUES (${edges[0].fromEntityId}, ${chunk.id}, 'wrong project claim')`;

  const shared = await post("/v1/graph/search", { project: undefined, query: project.name, top_k: 10 });
  assert.equal(shared.entities.find((e: { id: string }) => e.id === edges[0].fromEntityId)?.description, null);
  assert.deepEqual(shared.relations.map((r: { id: string }) => r.id).sort(), edges.map(r => r.id).sort());
  assert.deepEqual(new Set(shared.entities.map((e: { project: string }) => e.project)), new Set([project.name, sibling]));
  assert.deepEqual(new Set(shared.entities.map((e: { id: string }) => e.id)), new Set(edges.flatMap(r => [r.fromEntityId, r.toEntityId])));

  const filtered = await post("/v1/graph/search", { query: project.name });
  assert.deepEqual(filtered.relations.map((r: { id: string }) => r.id), [edges[0].id]);
  const notFound = await post("/v1/graph/search", { project: foreign, query: project.name }, 404);
  assert.equal(notFound.code, "PROJECT_NOT_FOUND");
  assert.equal(await db.project.count({ where: { name: foreign, orgId: "default" } }), 0);
});

run("shared tag search and graph navigation use the same visible records", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, project, post } = graph;
  const sibling = await db.project.create({ data: { name: `${project.name}-sibling`, slug: `${project.slug}-sibling`, orgId: project.orgId } });
  t.after(() => db.project.delete({ where: { id: sibling.id } }).then(() => undefined));
  const firstSource = await seedSource(graph, "first");
  const other = { ...graph, project: sibling };
  const secondSource = await seedSource(other, "second");
  const first = await seedChunk(graph, firstSource.id, "Zeolite desiccant guide", undefined, vector);
  const second = await seedChunk(other, secondSource.id, "Zeolite desiccant checklist", undefined, vector);
  const retired = await seedSource(other, "retired");
  const stale = await seedChunk(other, retired.id, "Zeolite desiccant retired", undefined, vector);
  const tag = `machine:${project.slug}`;
  await db.chunk.updateMany({ where: { id: { in: [first.id, second.id, stale.id] } }, data: { metadata: { tags: [`  ${tag}\t`] } } });
  await db.source.update({ where: { id: retired.id }, data: { deletedAt: new Date() } });

  // Matching the same machine and project must select the right candidate before top_k.
  const common = { project: undefined, query: "zeolite desiccant", top_k: 1, rerank: false, use_cache: false, threshold: 0 };
  for (const ranking of [{ use_vector: false }, { hybrid: false }]) {
    const hit = await post("/v1/context/query", { ...common, ...ranking, tags: [tag, `project:${sibling.slug}`] });
    assert.deepEqual(hit.results.map((result: { id: string }) => result.id), [second.id]);
    assert.deepEqual(new Set(hit.results[0].metadata.tags), new Set([tag, `project:${sibling.slug}`]));
    const absent = await post("/v1/context/query", { ...common, ...ranking, tags: [tag, "machine:unknown"] });
    assert.deepEqual(absent.results, []);
  }

  const view = await post("/v1/graph/search", { project: undefined, query: tag, entity_types: ["knowledge_tag"] });
  const node = view.entities.find((entity: { name: string; entityType: string }) => entity.name === tag && entity.entityType === "tag");
  assert.ok(node);
  assert.deepEqual(new Set(view.relations.filter((edge: { fromEntityId: string }) => edge.fromEntityId === node.id)
    .map((edge: { toEntityId: string }) => edge.toEntityId)), new Set([`document:${first.documentId}`, `document:${second.documentId}`]));
  // Existing manually written entities of type tag still use ordinary entity traversal.
  const manual = await post("/v1/entities", { name: tag, entity_type: "tag" }, 201);
  const legacy = await post("/v1/graph/search", { query: tag, entity_types: ["tag"] });
  assert.deepEqual(legacy.entities.map((item: { id: string }) => item.id), [manual.id]);
});

run("tag search and graph expose a version only after it becomes active", async t => {
  const graph = await fixture(t);
  const { db, project, post } = graph;
  const source = await seedSource(graph, "publication fixture");
  const version = await db.sourceVersion.create({ data: { sourceId: source.id, orgId: project.orgId, versionNumber: 1 } });
  const chunk = await seedChunk(graph, source.id, "Bentonite publication guide", version.id);
  const tag = `project:${project.slug}`;
  const search = { query: "bentonite", tags: [tag], threshold: 0, use_vector: false, rerank: false };
  const lookup = { query: tag, entity_types: ["knowledge_tag"] };
  // Materialized rows are not published just because they have searchable text.
  for (const state of ["READY", "ERROR"] as const) {
    await db.document.update({ where: { id: chunk.documentId }, data: { status: state } });
    assert.deepEqual((await post("/v1/context/query", search)).results, [], state);
    assert.deepEqual((await post("/v1/graph/search", lookup)).entities, [], state);
  }
  await db.document.update({ where: { id: chunk.documentId }, data: { status: "READY" } });
  await db.source.update({ where: { id: source.id }, data: { activeVersionId: version.id } });
  assert.equal((await post("/v1/context/query", search)).results[0]?.id, chunk.id);
  assert.ok((await post("/v1/graph/search", lookup)).entities.some((node: { id: string }) => node.id === `document:${chunk.documentId}`));
});

run("context search ranks documents across projects and retains their provenance", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, project, post } = graph;
  const sibling = await db.project.create({ data: { name: `${project.name}-sibling`, slug: `${project.slug}-sibling`, orgId: project.orgId } });
  t.after(async () => { await db.project.delete({ where: { id: sibling.id } }); });
  const firstSource = await seedSource(graph, "first");
  const secondGraph = { ...graph, project: sibling };
  const secondSource = await seedSource(secondGraph, "second");
  const first = await seedChunk(graph, firstSource.id, "Zeolite desiccant guide", undefined, vector);
  const second = await seedChunk(secondGraph, secondSource.id, "Zeolite desiccant checklist", undefined, vector);
  const unrelated = await seedChunk(secondGraph, secondSource.id, "Private details from an unrelated document");
  await db.chunk.update({ where: { id: first.id }, data: { metadata: { parent_chunk_id: unrelated.id } } });

  // A stale source must stay invisible even when its chunk matches in both ranking paths.
  const retired = await seedSource(secondGraph, "retired");
  await db.source.update({ where: { id: retired.id }, data: { deletedAt: new Date() } });
  await seedChunk(secondGraph, retired.id, "Zeolite desiccant retired", undefined, vector);

  const common = { query: "zeolite desiccant", rerank: false, use_cache: false, threshold: 0.9 };
  for (const search of [{ use_vector: false }, { hybrid: false }]) {
    const response = await post("/v1/context/query", { ...common, ...search, project: undefined });
    assert.deepEqual(new Map(response.results.map((hit: { id: string; project: string }) => [hit.id, hit.project])),
      new Map([[first.id, project.name], [second.id, sibling.name]]));
    const filtered = await post("/v1/context/query", { ...common, ...search, project: sibling.slug });
    assert.deepEqual(filtered.results.map((hit: { id: string }) => hit.id), [second.id]);
  }
  // Parent metadata must not introduce content outside the matched document.
  const withParent = await post("/v1/context/query", { ...common, use_vector: false, include_parent_content: true });
  assert.equal(withParent.results[0]?.id, first.id);
  assert.match(withParent.context, /Zeolite desiccant guide/);
  assert.ok(!withParent.context.includes(unrelated.content));
  assert.equal(withParent.results[0].metadata.parent_content, undefined);

  const missing = `${project.name}-missing`;
  const refused = await post("/v1/context/query", { ...common, project: missing }, 404);
  assert.equal(refused.code, "PROJECT_NOT_FOUND");
  assert.equal(await db.project.count({ where: { name: missing } }), 0);
});

run("SDK query without a configured project returns shared knowledge", { timeout: 25_000 }, async t => {
  const graph = await fixture(t);
  const { project, post } = graph;
  const query = `zirconia ${project.name}`;
  const source = await seedSource(graph, "SDK fixture");
  const chunk = await seedChunk(graph, source.id, query);
  const { api } = await import("../src/api/routes.js");
  const { RetainDBContext } = await import("../../sdk/src/index.js");
  const inferenceFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname === "sdk-fixture.invalid") {
      return api.fetch(new Request(input, init));
    }
    return inferenceFetch(input, init);
  });
  const client = new RetainDBContext({ apiKey: credential, baseUrl: "https://sdk-fixture.invalid" });
  const params = { query, rerank: false, use_cache: false, use_vector: false };
  assert.equal((await client.query(params)).results[0]?.id, chunk.id);
  assert.equal((await client.withProject(project.slug).query(params)).results[0]?.id, chunk.id);
  const { RetainDBClient } = await import("../../sdk/src/whisper.js");
  const configured = new RetainDBClient({ apiKey: credential, baseUrl: "https://sdk-fixture.invalid", project: project.slug });
  const tagged = { ...params, tags: [`project:${project.slug}`] };
  assert.equal((await configured.query(tagged)).results[0]?.id, chunk.id);
  await assert.rejects(configured.query({ ...tagged, include_memories: true }), {
    status: 400, details: { code: "TAGS_WITH_PERSONAL_MEMORIES", error: "Knowledge tags do not filter personal memories" },
  });
  const invalid = await post("/v1/context/query", { ...params, include_memories: true, project: undefined }, 400);
  assert.equal(invalid.code, "PROJECT_REQUIRED");
});

run("graph search honors depth, direction and project-local edges", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, project, post } = graph;
  const [seed, neighbor, distant] = await Promise.all([
    seedEntity(graph, "Snapshot", undefined, true),
    seedEntity(graph, "Checksum"),
    seedEntity(graph, "Verification"),
  ]);
  const outsideName = `${project.name}-outside`;
  const outside = await db.project.create({ data: { name: outsideName, slug: outsideName, orgId: "default" } });
  t.after(async () => { await db.project.delete({ where: { id: outside.id } }); });
  const foreign = await seedEntity({ ...graph, project: outside }, "Other project");
  // Directional fixture: the seed is the source, so each hop walks outward as the traversal does.
  const edges = [[seed, neighbor], [neighbor, distant], [seed, foreign]];
  await db.entityRelation.createMany({ data: edges.map(([fromEntityId, toEntityId]) => ({
    projectId: project.id, fromEntityId, toEntityId, relationType: "references",
  })) });

  const shallow: GraphResponse = await post("/v1/graph/search", { query: "snapshot", depth: 1, top_k: 1 });
  assert.deepEqual(new Set(shallow.entities.map(({ id }) => id)), new Set([seed, neighbor]));
  assert.deepEqual(shallow.relations.map((edge) => [edge.fromEntityId, edge.toEntityId]), [[seed, neighbor]]);

  const deep: GraphResponse = await post("/v1/graph/search", { query: "snapshot", depth: 2, top_k: 1 });
  assert.deepEqual(new Set(deep.entities.map(({ id }) => id)), new Set([seed, neighbor, distant]));
  assert.deepEqual(new Set(deep.relations.map((edge) => `${edge.fromEntityId}/${edge.toEntityId}`)),
    new Set([`${seed}/${neighbor}`, `${neighbor}/${distant}`]));
  // Seed 1.0, one hop at lambda 0.7, two hops at 0.7 * 0.7.
  assert.deepEqual(deep.entities.map(({ score }) => score), [1, 0.7, 0.49]);
});

run("context query includes linked chunks without escaping explicit source scope", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, project, post } = graph;
  const allowed = await seedSource(graph, "allowed");
  const omitted = await seedSource(graph, "omitted");
  const [start, neighbor, distant, outside] = await Promise.all([
    seedChunk(graph, allowed.id, "Snapshot"),
    seedChunk(graph, allowed.id, "Checksum"),
    seedChunk(graph, allowed.id, "Verification"),
    seedChunk(graph, omitted.id, "Unselected source"),
  ]);
  const [a, b, c, d] = await Promise.all([
    seedEntity(graph, "Snapshot", start.id, true),
    seedEntity(graph, "Checksum", neighbor.id),
    seedEntity(graph, "Verification", distant.id),
    seedEntity(graph, "Unselected source", outside.id),
  ]);
  await db.entityRelation.createMany({ data: [[a, b], [b, c], [a, d]].map(([fromEntityId, toEntityId]) => ({
    projectId: project.id, fromEntityId, toEntityId, relationType: "references",
  })) });
  const query = { query: "snapshot", source_ids: [allowed.id], use_vector: false, hybrid: false, rerank: false, top_k: 12 };
  const without = await post("/v1/context/query", query);
  assert.deepEqual(without.results, []);

  const withGraph = { ...query, include_graph: true };
  const shallow = await post("/v1/context/query", { ...withGraph, graph_depth: 1 });
  assert.deepEqual(new Set(shallow.results.map((hit: { id: string }) => hit.id)), new Set([start.id, neighbor.id]));

  const deep = await post("/v1/context/query", { ...withGraph, graph_depth: 2 });
  assert.deepEqual(new Set(deep.results.map((hit: { id: string }) => hit.id)), new Set([start.id, neighbor.id, distant.id]));
  assert.ok(deep.results.every((hit: { retrieval_source: string }) => hit.retrieval_source === "graph"));
});

run("context query keeps graph evidence when a vector result wins deduplication", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, project, post } = graph;
  const source = await seedSource(graph, "references");
  const start = await seedChunk(graph, source.id, "Snapshot");
  const end = await seedChunk(graph, source.id, "Checksum");
  const a = await seedEntity(graph, "Snapshot", start.id, true);
  const b = await seedEntity(graph, "Checksum", end.id);
  const relation = await db.entityRelation.create({
    data: { projectId: project.id, fromEntityId: a, toEntityId: b, relationType: "references" },
  });
  await db.$executeRaw`UPDATE chunks SET embedding = ${`[${vector.join(",")}]`}::vector WHERE id = ${start.id}`;
  const orthogonal = `[0,${vector.slice(0, -1).join(",")}]`;
  await db.$executeRaw`UPDATE chunks SET embedding = ${orthogonal}::vector WHERE id = ${end.id}`;

  const query = { query: "snapshot", hybrid: false, use_vector: true, rerank: false, top_k: 3 };
  const plain = await post("/v1/context/query", query);
  assert.equal(plain.results.length, 1);
  assert.equal(plain.results[0].metadata.graph, undefined);

  const enriched = await post("/v1/context/query", { ...query, include_graph: true });
  const first = enriched.results.find((hit: { id: string }) => hit.id === start.id);
  assert.equal(first.retrieval_source, "vector");
  assert.deepEqual(first.metadata.graph, {
    entities: [{ id: a, name: "Snapshot", type: "concept" }],
    relations: [{ id: relation.id, from_entity_id: a, to_entity_id: b, type: "references", weight: 1 }],
  });
  const linked = enriched.results.find((hit: { id: string }) => hit.id === end.id);
  assert.equal(linked?.retrieval_source, "graph");
});

run("context graph returns a neighboring chunk even when seeds fill its budget", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, post, project } = graph;
  const source = await seedSource(graph, "manual-guides");
  const seedNames = ["Snapshot", "Partition", "Archive", "Catalog"];
  const seeds: string[] = [];
  for (const name of seedNames) {
    const chunk = await seedChunk(graph, source.id, name);
    seeds.push(await seedEntity(graph, name, chunk.id, true));
  }
  const linked = await seedChunk(graph, source.id, "Checksum");
  const neighbor = await seedEntity(graph, "Checksum", linked.id);
  await db.entityRelation.create({ data: {
    projectId: project.id, fromEntityId: seeds[0], toEntityId: neighbor, relationType: "references",
  } });
  const result = await post("/v1/context/query", {
    query: "snapshot", include_graph: true, hybrid: false, use_vector: false, rerank: false,
  });
  assert.equal(result.results.length, 4);
  assert.ok(result.results.some((hit: { id: string }) => hit.id === linked.id));
});

run("staging and promotion select chunk claims without replacing active graph identities", { timeout: 25_000 }, async (t) => {
  let claims = extraction;
  const graph = await fixture(t, () => claims);
  const { project, post } = graph;
  const { extractEntities } = await import("../src/engine/extractor.js");
  const versions = await import("../src/engine/source-versions.js");
  const source = await seedSource(graph, "restore-guide");
  const active = await versions.ensureActiveSourceVersion(source.id);
  assert.ok(active);
  const before = await seedChunk(graph, source.id, "Original restore guide", active.id, vector);
  await extractEntities(project.id, before.id, before.content.repeat(8), "text", extractionSource(source.id, before, before.content.repeat(8), active.id));
  const queryGraph = (): Promise<GraphResponse> => post("/v1/graph/search", { query: "snapshot" });
  const queryContext = () => post("/v1/context/query", {
    query: "snapshot", include_graph: true, hybrid: false, use_vector: false, rerank: false,
  });
  const initialGraph = await queryGraph();
  const seed = initialGraph.entities.find((entity) => entity.name === "Snapshot");
  assert.ok(seed);
  assert.equal(initialGraph.relations.length, 1);
  assert.deepEqual((await queryContext()).results.map((hit: { id: string }) => hit.id), [before.id]);

  const staged = await versions.createStagedSourceVersion(source.id);
  const next = await seedChunk(graph, source.id, "Replacement restore guide", staged.id, vector);
  claims = { entities: [
    { ...extraction.entities[0], description: "Replacement snapshot instructions" },
    extraction.entities[1],
    { name: "Replacement", type: "concept", description: "Newly indexed source fact" },
  ], relations: [] };
  await extractEntities(project.id, next.id, next.content.repeat(8), "text", extractionSource(source.id, next, next.content.repeat(8), staged.id));
  const whileStaged = { graph: await queryGraph(), context: await queryContext() };
  await versions.failSourceVersion({ sourceId: source.id, sourceVersionId: staged.id, errorMessage: "fixture failure" });
  const whileFailed = await queryContext();

  const replacement = await versions.createStagedSourceVersion(source.id);
  const current = await seedChunk(graph, source.id, "Current restore guide", replacement.id, vector);
  await extractEntities(project.id, current.id, current.content.repeat(8), "text", extractionSource(source.id, current, current.content.repeat(8), replacement.id));
  await versions.promoteSourceVersion({ sourceId: source.id, sourceVersionId: replacement.id });
  const afterPromotion = { graph: await queryGraph(), context: await queryContext() };

  // Read both API surfaces before and after the source pointer changes.
  assert.deepEqual(whileStaged.context.results.map((hit: { id: string }) => hit.id), [before.id]);
  assert.deepEqual(whileFailed.results.map((hit: { id: string }) => hit.id), [before.id]);
  assert.deepEqual(new Set(whileStaged.graph.entities.map(({ name }) => name)), new Set(["Snapshot", "Checksum"]));
  assert.equal(whileStaged.graph.entities.find(({ id }) => id === seed.id)?.description, seed.description);
  assert.equal(whileStaged.graph.relations.length, 1);
  assert.deepEqual(afterPromotion.context.results.map((hit: { id: string }) => hit.id), [current.id]);
  assert.equal(afterPromotion.graph.entities.find(({ id }) => id === seed.id)?.description, "Replacement snapshot instructions");
  assert.deepEqual(afterPromotion.graph.relations, []);
});

run("standalone graph excludes deleted source facts without hiding manual entities", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { project, get, post } = graph;
  const { extractEntities } = await import("../src/engine/extractor.js");
  const { softDeleteSource } = await import("../src/engine/source-versions.js");
  const source = await seedSource(graph, "deleted-guide");
  const chunk = await seedChunk(graph, source.id, "Guide about the snapshot and its checksum");
  const manual = await post("/v1/entities", { name: "Snapshot retention", entity_type: "concept" }, 201);
  await extractEntities(project.id, chunk.id, chunk.content.repeat(8), "text", extractionSource(source.id, chunk, chunk.content.repeat(8)));
  const before: GraphResponse = await post("/v1/graph/search", { query: "snapshot" });
  assert.equal(before.relations.length, 1);
  const exportGraph = () => post("/v1/index/bundle", { include: { entities: true, relations: true } });
  const beforeExport = await exportGraph();
  assert.equal(beforeExport.bundle.contents.entities.find((entity: { name: string }) => entity.name === "Snapshot")?.description,
    "A database snapshot");
  await softDeleteSource({ sourceId: source.id, retentionDays: 1 });
  // The shorter, deleted name would take the only seed slot if filtered after ranking.
  const result: GraphResponse = await post("/v1/graph/search", { query: "snapshot", top_k: 1 });
  assert.deepEqual(result.entities.map(({ id }) => id), [manual.id]);
  assert.deepEqual(result.relations, []);
  const exported = await exportGraph();
  assert.deepEqual(exported.bundle.contents.entities.map(({ id }: { id: string }) => id), [manual.id]);
  assert.deepEqual(exported.bundle.contents.relations.entity_relations, []);
  const stats = await get(`/v1/projects/${project.id}/stats`);
  assert.equal(stats.status, 200);
  assert.equal((await stats.json()).entities, 1);
});

run("entity extraction preserves the manual annotation and weight of an existing edge", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, project, post } = graph;
  const { extractEntities } = await import("../src/engine/extractor.js");
  const source = await seedSource(graph, "annotated-guide");
  const chunk = await seedChunk(graph, source.id, "Guide about the snapshot and its checksum");
  const edge = await post("/v1/relations", {
    from_entity: "Snapshot", from_type: "concept", to_entity: "Checksum", to_type: "concept",
    relation_type: "references", metadata: { reviewer: { status: "verified" } }, weight: 0.6,
  }, 201);
  await extractEntities(project.id, chunk.id, chunk.content.repeat(8), "text", extractionSource(source.id, chunk, chunk.content.repeat(8)));
  const stored = await db.entityRelation.findUniqueOrThrow({ where: { id: edge.id } });
  assert.deepEqual(stored.metadata, { reviewer: { status: "verified" } });
  assert.equal(stored.weight, 0.6);
  const current: GraphResponse = await post("/v1/graph/search", { query: "snapshot" });
  assert.deepEqual(current.relations.map(({ id }) => id), [edge.id]);
});

run("a repeated graph query reflects a source version change", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, post } = graph;
  const source = await seedSource(graph, "active");
  const chunk = await seedChunk(graph, source.id, "Snapshot");
  await seedEntity(graph, "Snapshot", chunk.id, true);
  const query = { query: "snapshot", include_graph: true, hybrid: false, use_vector: false, rerank: false };
  const initial = await post("/v1/context/query", query);
  assert.equal(initial.results[0].id, chunk.id);

  // The indexed chunk remains stored, but is no longer part of the active source.
  const version = await db.sourceVersion.create({ data: { sourceId: source.id, orgId: "default", versionNumber: 1 } });
  await db.source.update({ where: { id: source.id }, data: { activeVersionId: version.id } });
  const current = await post("/v1/context/query", query);
  assert.deepEqual(current.results, []);
});

run("graph and context queries do not seed from a different embedding model", { timeout: 25_000 }, async (t) => {
  const graph = await fixture(t);
  const { db, post } = graph;
  const source = await seedSource(graph, "model-provenance");
  const compatible = await seedChunk(graph, source.id, "Compatible graph evidence", undefined, vector);
  const incompatible = await seedChunk(graph, source.id, "Different model graph evidence", undefined, vector);
  // Identical coordinates in different models do not establish a semantic match.
  await db.chunk.update({ where: { id: compatible.id }, data: { metadata: { embedding_model: queryEmbeddingModel } } });
  await db.chunk.update({ where: { id: incompatible.id }, data: { metadata: { embedding_model: "another-model" } } });
  const expected = await seedEntity(graph, "Compatible concept", compatible.id, true);
  const other = await seedEntity(graph, "Other concept", incompatible.id, true);

  const direct: GraphResponse = await post("/v1/graph/search", { query: "maintenance" });
  assert.deepEqual(direct.entities.map(({ id }) => id), [expected]);
  const context = await post("/v1/context/query", {
    query: "maintenance", include_graph: true, hybrid: false, use_vector: false, rerank: false,
  });
  assert.deepEqual(context.results.map(({ id }: { id: string }) => id), [compatible.id]);

  // A name match remains available without a comparable vector.
  const byName: GraphResponse = await post("/v1/graph/search", { query: "Other concept", top_k: 2 });
  assert.ok(byName.entities.some(({ id }) => id === other));
});

run("incomplete extraction does not erase the graph of an already indexed chunk", { timeout: 25_000 }, async (t) => {
  let claims: unknown = extraction;
  const graph = await fixture(t, () => claims);
  const { project, post } = graph;
  const { extractEntities } = await import("../src/engine/extractor.js");
  const source = await seedSource(graph, "restore-guide");
  const chunk = await seedChunk(graph, source.id, "Verify the snapshot checksum before restoring partitions.");
  const extract = () => extractEntities(project.id, chunk.id, chunk.content.repeat(5), "text", extractionSource(source.id, chunk, chunk.content.repeat(5)));
  const search = (): Promise<GraphResponse> => post("/v1/graph/search", { query: "snapshot" });
  await extract();
  const before = await search();
  assert.equal(before.relations.length, 1);

  // A provider can return valid JSON without the required graph fields.
  claims = {};
  await assert.rejects(extract());
  assert.deepEqual(await search(), before);

  claims = { entities: [], relations: [] };
  await extract();
  assert.deepEqual(await search(), { entities: [], relations: [] });
});

run("personal context answers never enter the shared response cache", { timeout: 25_000 }, async (t) => {
  const { db, project, post } = await fixture(t);
  const userId = randomUUID();
  const memory = await db.memory.create({ data: { projectId: project.id, userId, content: "Synthetic private fixture" } });
  await db.$executeRaw`UPDATE memories SET embedding = ${`[${vector.join(",")}]`}::vector WHERE id = ${memory.id}`;
  const body = {
    query: "synthetic private fixture", user_id: userId, include_memories: true, use_cache: true,
    hybrid: false, use_vector: false, rerank: false, oracle_mode: "off", retrieval_profile: "legacy",
  };
  const first = await post("/v1/context/query", body);
  assert.deepEqual(first.results.map(({ id }: { id: string }) => id), [memory.id]);

  // The second read must consult the current memory state, even with caching requested.
  await db.memory.update({ where: { id: memory.id }, data: { isActive: false } });
  const current = await post("/v1/context/query", body);
  assert.deepEqual({ cached: current.meta.cache_hit, results: current.results }, { cached: false, results: [] });
});

run("memory graph keeps stored and chronological edges within the requested conversation", { timeout: 25_000 }, async (t) => {
  const { db, get, project } = await fixture(t);
  const sessionId = "snapshot-review";
  const first = await db.memory.create({ data: { projectId: project.id, sessionId, content: "Save the snapshot", createdAt: new Date(1000) } });
  const second = await db.memory.create({ data: { projectId: project.id, sessionId, content: "Verify the checksum", createdAt: new Date(2000) } });
  const excluded = await db.memory.create({ data: { projectId: project.id, sessionId: "another-session", content: "Unrelated note" } });
  await db.memoryRelation.createMany({ data: [
    { fromMemoryId: first.id, toMemoryId: second.id, relationType: "supports" },
    { fromMemoryId: second.id, toMemoryId: excluded.id, relationType: "supports" },
  ] });

  const redirect = await get(`/v1/memory/graph/conversation/${sessionId}`);
  assert.equal(redirect.status, 307);
  const location = redirect.headers.get("location");
  assert.ok(location);
  const response = await get(location);
  assert.equal(response.status, 200);
  const graph = await response.json();
  assert.deepEqual(new Set(graph.nodes.map(({ id }: { id: string }) => id)), new Set([first.id, second.id]));
  assert.equal(graph.edges.length, 2);
  for (const edge of graph.edges) assert.deepEqual([edge.source, edge.target], [first.id, second.id]);
  assert.deepEqual(new Set(graph.edges.map(({ type }: { type: string }) => type)), new Set(["supports", "sequence"]));

  assert.equal((await get("/v1/memory/graph?limit=not-a-number")).status, 400);
  assert.equal((await get(`/v1/memory/graph/conversation/${sessionId}?limit=not-a-number`)).status, 400);
});

run("text ingestion creates searchable entity relations with their source chunk", { timeout: 25_000 }, async (t) => {
  const { post } = await fixture(t);
  const content = "Verify the snapshot checksum before restoring database partitions. ".repeat(5);
  await post("/v1/learn", { mode: "text", title: "Restore", content, options: { async: false, strategy_override: "fixed" } });

  // Extraction runs after chunk persistence; wait for its observable graph output.
  let result: GraphResponse = await post("/v1/graph/search", { query: "snapshot" });
  for (let attempt = 0; attempt < 15; attempt++) {
    if (result.relations.length > 0) break;
    await delay(60);
    result = await post("/v1/graph/search", { query: "snapshot" });
  }
  assert.deepEqual(new Set(result.entities.map(({ name }) => name)), new Set(["Snapshot", "Checksum"]));
  const ids = new Map(result.entities.map(({ name, id }) => [name, id]));
  assert.deepEqual(result.relations.map(({ fromEntityId, toEntityId, relationType }) => [fromEntityId, toEntityId, relationType]),
    [[ids.get("Snapshot"), ids.get("Checksum"), "references"]]);
  // Search with words that do not match an entity label; inference returns the ingested chunk's vector.
  const context = await post("/v1/context/query", {
    query: "database recovery", include_graph: true, hybrid: false, use_vector: false, rerank: false,
  });
  assert.ok(context.results.some((hit: { content: string; retrieval_source: string }) =>
    hit.retrieval_source === "graph" && hit.content.includes("snapshot checksum")),
  "graph-only context should find the ingested chunk using its stored vector");
});

after(async () => {
  if (!databaseUrl) return;
  await (await import("../src/db/index.js")).db.$disconnect();
  process.env = originalEnvironment;
});
