import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const vector = [1, ...Array<number>(1023).fill(0)];
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
    choices: [{ message: { content: JSON.stringify(claims()) } }],
  }));
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    const { inputs } = JSON.parse(String(options?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(() => vector) });
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
    INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", embedding, "updatedAt")
    VALUES (${id}, ${project.id}, ${name}, 'concept', 'concept', ${sourceChunkId === undefined},
      ${sourceChunkId === undefined ? embedding : null}::vector, NOW())
  `;
  if (sourceChunkId) await db.$executeRaw`
    INSERT INTO entity_mentions ("entityId", "chunkId", embedding) VALUES (${id}, ${sourceChunkId}, ${embedding}::vector)
  `;
  return id;
}

async function seedSource({ db, project }: GraphFixture, name: string) {
  return db.source.create({ data: { projectId: project.id, name, type: "text", status: "READY" } });
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
  assert.deepEqual(found.relations.map(({ id }) => id), [repeated.id]);
});

run("graph search honors depth and returns both endpoints of project-local edges", { timeout: 25_000 }, async (t) => {
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
  const edges = [[neighbor, seed], [neighbor, distant], [seed, foreign]];
  await db.entityRelation.createMany({ data: edges.map(([fromEntityId, toEntityId]) => ({
    projectId: project.id, fromEntityId, toEntityId, relationType: "references",
  })) });

  const shallow: GraphResponse = await post("/v1/graph/search", { query: "snapshot", depth: 1, top_k: 1 });
  assert.deepEqual(new Set(shallow.entities.map(({ id }) => id)), new Set([seed, neighbor]));
  assert.deepEqual(shallow.relations.map((edge) => [edge.fromEntityId, edge.toEntityId]), [[neighbor, seed]]);

  const deep: GraphResponse = await post("/v1/graph/search", { query: "snapshot", depth: 2, top_k: 1 });
  assert.deepEqual(new Set(deep.entities.map(({ id }) => id)), new Set([seed, neighbor, distant]));
  assert.deepEqual(new Set(deep.relations.map((edge) => `${edge.fromEntityId}/${edge.toEntityId}`)),
    new Set([`${neighbor}/${seed}`, `${neighbor}/${distant}`]));
  assert.deepEqual(deep.entities.map(({ score }) => score), [1, 0, 0]);
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
  await db.entityRelation.createMany({ data: [[b, a], [b, c], [a, d]].map(([fromEntityId, toEntityId]) => ({
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
  await extractEntities(project.id, before.id, before.content.repeat(8), "text");
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
  await extractEntities(project.id, next.id, next.content.repeat(8), "text");
  const whileStaged = { graph: await queryGraph(), context: await queryContext() };
  await versions.failSourceVersion({ sourceId: source.id, sourceVersionId: staged.id, errorMessage: "fixture failure" });
  const whileFailed = await queryContext();

  const replacement = await versions.createStagedSourceVersion(source.id);
  const current = await seedChunk(graph, source.id, "Current restore guide", replacement.id, vector);
  await extractEntities(project.id, current.id, current.content.repeat(8), "text");
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
  await extractEntities(project.id, chunk.id, chunk.content.repeat(8), "text");
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
  await extractEntities(project.id, chunk.id, chunk.content.repeat(8), "text");
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

run("incomplete extraction does not erase the graph of an already indexed chunk", { timeout: 25_000 }, async (t) => {
  let claims: unknown = extraction;
  const graph = await fixture(t, () => claims);
  const { project, post } = graph;
  const { extractEntities } = await import("../src/engine/extractor.js");
  const source = await seedSource(graph, "restore-guide");
  const chunk = await seedChunk(graph, source.id, "Verify the snapshot checksum before restoring partitions.");
  const extract = () => extractEntities(project.id, chunk.id, chunk.content.repeat(5), "text");
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
