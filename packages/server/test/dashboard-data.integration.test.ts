import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";
import OpenAI from "openai";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const runBrowser = databaseUrl && process.env.RETAINDB_TEST_CHROME_CHANNEL ? test : test.skip;
const origin = "https://retained.example.test";
const authUrl = "https://identity.example.test/api/authz/forward-auth";
const inferenceUrl = "https://embeddings.example.test";
const apiKey = randomUUID();
const cookie = "authelia_session=fixture-session";
const hidden = "not-visible-in-the-dashboard";
const coordinates = (x: number, y: number) => [x, y, ...Array<number>(1022).fill(0)];
const vector = (x: number, y: number) => `[${coordinates(x, y).join(",")}]`;

async function refreshStatistics() {
  const { refreshDashboardStatistics } = await import("../src/engine/dashboard-data.js");
  await refreshDashboardStatistics();
}

if (databaseUrl) Object.assign(process.env, {
  DATABASE_URL: databaseUrl, RETAINDB_API_KEY: apiKey, ENCRYPTION_KEY: randomUUID(), EMBEDDING_MODE: "remote",
  EMBEDDING_INFERENCE_BASE_URL: inferenceUrl, REMOTE_INFERENCE_REQUIRED: "true",
  DISABLE_AUTO_EXTRACTION: "true", ALERT_EMAIL_ENABLED: "false",
});

async function fixture(t: TestContext, modelForText?: (text: string) => string | undefined) {
  Object.assign(process.env, { RETAINDB_DASHBOARD_ORIGIN: origin, RETAINDB_DASHBOARD_AUTH_URL: authUrl });
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url) === authUrl) {
      const isAdmin = new Headers(init?.headers).get("cookie") === "authelia_session=fixture-admin";
      return new Response(null, { headers: { "Remote-User": "operator", "Remote-Groups": isAdmin ? "admins" : "readers" } });
    }
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    assert.ok(modelForText, "Only the embedding provenance scenarios call inference");
    const { inputs } = JSON.parse(String(init?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(() => coordinates(1, 0)), model: modelForText(inputs[0]) });
  });
  const { db } = await import("../src/db/index.js");
  const { createNodeApp } = await import("../src/api/app.js");
  const slug = `dashboard-${randomUUID()}`;
  const orgId = `${slug}-org`;
  await db.$executeRaw`INSERT INTO users (id, email, "updatedAt") VALUES (${orgId}, ${`${orgId}@example.test`}, NOW())`;
  await db.$executeRaw`INSERT INTO organizations (id, name, slug, "ownerId", "updatedAt") VALUES (${orgId}, ${orgId}, ${orgId}, ${orgId}, NOW())`;
  const project = await db.project.create({ data: { name: slug, slug } });
  const other = await db.project.create({ data: { name: hidden, slug: `${slug}-foreign`, orgId } });
  // The tests own these uniquely named fixture records.
  t.after(async () => {
    await db.$executeRaw`DELETE FROM ingestion_jobs WHERE project_id IN (${project.id}, ${other.id})`;
    await db.$executeRaw`DELETE FROM repo_index_scopes WHERE "projectId" = ${project.id}`;
    await db.project.deleteMany({ where: { id: { in: [project.id, other.id] } } });
    await db.$executeRaw`DELETE FROM organizations WHERE id = ${orgId}`;
    await db.$executeRaw`DELETE FROM users WHERE id = ${orgId}`;
  });
  const app = createNodeApp({ includeApiRoutes: false });
  const read = (view: string, args: Record<string, string> = { project: project.id }) =>
    app.request(`${origin}/dashboard/data/${view}?${new URLSearchParams(args)}`, { headers: { cookie } });
  return { db, read, project, other };
}

after(async () => {
  if (databaseUrl) await (await import("../src/db/index.js")).db.$disconnect();
});

run("the signed-in dashboard shares knowledge across projects without crossing organizations", async (t) => {
  const { db, project, other, read } = await fixture(t);
  const sibling = await db.project.create({ data: { name: "Sibling", slug: `${project.slug}-sibling` } });
  t.after(async () => { await db.project.delete({ where: { id: sibling.id } }); });
  const names = ["Shared reader", "Shared index", hidden];
  const entities: { id: string }[] = [];
  // A foreign project deliberately has rows that claim the default organization.
  for (const [index, owner] of [project, sibling, other].entries()) {
    const name = names[index];
    const source = await db.source.create({ data: { projectId: owner.id, name, type: "text", status: "READY" } });
    const document = await db.document.create({ data: { sourceId: source.id, projectId: owner.id, title: name, status: "READY" } });
    const chunk = await db.chunk.create({ data: { documentId: document.id, projectId: owner.id, content: name, metadata: { embedding_model: "fixture/shared" } } });
    await db.$executeRaw`UPDATE chunks SET embedding = ${vector(1, index)}::vector WHERE id = ${chunk.id}`;
    await db.memory.create({ data: { content: name, projectId: owner.id, orgId: project.orgId } });
    entities.push(await db.entity.create({ data: { name, type: "concept", projectId: owner.id, isManual: true } }));
  }
  for (const target of entities.slice(1)) {
    await db.entityRelation.create({ data: { projectId: project.id, fromEntityId: entities[0].id, toEntityId: target.id, relationType: "references", isManual: true } });
  }

  await refreshStatistics();
  const shared = { scope: "shared" };
  const overview = await read("overview", shared);
  assert.equal(overview.status, 200);
  const counts = await overview.json();
  assert.deepEqual(counts.models.find((item: { model: string }) => item.model === "fixture/shared"), { model: "fixture/shared", count: 2 });
  assert.ok(counts.memories >= 2);
  const graph = await (await read("graph", { ...shared, q: names[0] })).json();
  assert.deepEqual(graph.nodes.map((node: { label: string; project: string }) => [node.label, node.project]), [[names[0], project.name], [names[1], sibling.name]]);
  assert.deepEqual(graph.edges.map((edge: { toEntityId: string }) => edge.toEntityId), [entities[1].id]);
  const map = await (await read("vectors", { ...shared, model: "fixture/shared" })).json();
  assert.deepEqual(new Map(map.points.map((p: { label: string; project: string }) => [p.label, p.project])), new Map([[names[0], project.name], [names[1], sibling.name]]));
  assert.equal((await read("graph", { ...shared, project: other.id })).status, 400);
  const filtered = await (await read("graph", { project: project.id, q: names[0] })).json();
  assert.deepEqual(filtered.nodes.map((node: { label: string }) => node.label), [names[0]]);
  assert.deepEqual(filtered.edges, []);
});

run("dashboard counts use a snapshot while vector samples and publication checks stay live", async (t) => {
  const { db, project, read } = await fixture(t);
  const source = await db.source.create({ data: { projectId: project.id, name: "Snapshot fixture", type: "text" } });
  const document = await db.document.create({ data: { sourceId: source.id, projectId: project.id, title: "Visible snapshot", status: "READY" } });
  const model = "fixture/snapshot-model";
  const first = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, content: "First point", metadata: { embedding_model: model } } });
  await db.$executeRaw`UPDATE chunks SET embedding = ${vector(1, 0)}::vector WHERE id = ${first.id}`;
  await refreshStatistics();

  // New chunks are immediately eligible for the plot but counts are served from the last refresh.
  const overview = await read("overview");
  assert.equal(overview.status, 200);
  const initial = await overview.json();
  assert.equal(initial.chunks, 1);
  assert.ok(Number.isFinite(Date.parse(initial.countsAsOf)), "show when the last successful snapshot was taken");
  const later = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, chunkIndex: 1, content: "New point", metadata: { embedding_model: model } } });
  await db.$executeRaw`UPDATE chunks SET embedding = ${vector(0, 1)}::vector WHERE id = ${later.id}`;
  assert.equal((await (await read("overview")).json()).chunks, 1, "the dashboard must not run a live corpus count");
  const map = await (await read("vectors", { project: project.id, model })).json();
  assert.deepEqual(map.models, [{ model, count: 1 }]);
  assert.equal(map.countsAsOf, initial.countsAsOf);
  assert.deepEqual(new Set(map.points.map(({ id }: { id: string }) => id)), new Set([first.id, later.id]));
  await refreshStatistics();
  const refreshed = await (await read("overview")).json();
  assert.equal(refreshed.chunks, 2);
  assert.ok(Date.parse(refreshed.countsAsOf) > Date.parse(initial.countsAsOf));

  // Retiring the source must hide old counts and the model without waiting for a refresh.
  await db.source.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
  const withdrawn = await (await read("overview")).json();
  assert.deepEqual([withdrawn.documents, withdrawn.sources, withdrawn.chunks, withdrawn.embedded, withdrawn.models], [0, 0, 0, 0, []]);
  assert.equal((await read("vectors", { project: project.id, model })).status, 404);
});

run("the Vector map can open a new model before the dashboard counts refresh", async (t) => {
  const { db, project, read } = await fixture(t);
  const source = await db.source.create({ data: { projectId: project.id, name: "Live model fixture", type: "text" } });
  const document = await db.document.create({ data: { sourceId: source.id, projectId: project.id, title: "Live model", status: "READY" } });
  const chunk = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, content: "Vector changes model", metadata: { embedding_model: "fixture/old-model" } } });
  await db.$executeRaw`UPDATE chunks SET embedding = ${vector(1, 0)}::vector WHERE id = ${chunk.id}`;
  await refreshStatistics();

  // After a model change neither the bookmarked route nor the default depends on stale membership.
  const model = "fixture/new-model";
  await db.chunk.update({ where: { id: chunk.id }, data: { metadata: { embedding_model: model } } });
  for (const requested of [model, undefined]) {
    const args: Record<string, string> = { project: project.id };
    if (requested) args.model = requested;
    const response = await read("vectors", args);
    assert.equal(response.status, 200);
    const map = await response.json();
    assert.equal(map.model, model);
    assert.deepEqual(map.models.find((item: { model: string }) => item.model === model), { model, count: null });
    assert.deepEqual(map.points.map((point: { id: string }) => point.id), [chunk.id]);
  }
  assert.equal((await read("vectors", { project: project.id, model: "fixture/old-model" })).status, 404);
});

run("the shared graph opens on recent published knowledge, not the highest chunk IDs", async (t) => {
  const { db, project, other, read } = await fixture(t);
  const source = await db.source.create({ data: { name: "Recent graph source", type: "text", projectId: project.id } });
  const old = await db.document.create({ data: { title: "Older knowledge", sourceId: source.id, projectId: project.id, status: "READY" } });
  const current = await db.document.create({ data: { title: "Current knowledge", sourceId: source.id, projectId: project.id, status: "READY" } });
  const staged = await db.document.create({ data: { title: hidden, sourceId: source.id, projectId: project.id, status: "PROCESSING" } });
  const foreignSource = await db.source.create({ data: { name: hidden, type: "text", projectId: other.id } });
  const foreign = await db.document.create({ data: { title: hidden, sourceId: foreignSource.id, projectId: other.id, status: "READY" } });
  const machineTag = `machine:${project.slug}`;

  // Deliberately reverse ID and creation order. Visibility must be checked before the sample limit.
  await db.chunk.createMany({ data: Array.from({ length: 384 }, (_, index) => ({
    id: `z-${project.id}-${index}`, documentId: old.id, projectId: project.id, content: "Older knowledge",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  })) });
  await db.chunk.createMany({ data: [
    { id: `a-${project.id}`, documentId: current.id, projectId: project.id, content: "Current knowledge",
      createdAt: new Date("2026-01-02T00:00:00Z"), metadata: { tags: [machineTag] } },
    { documentId: current.id, projectId: project.id, content: hidden,
      createdAt: new Date("2026-01-03T00:00:00Z"), metadata: { content_kind: "parent_context", tags: [hidden] } },
    { documentId: staged.id, projectId: project.id, content: hidden,
      createdAt: new Date("2026-01-03T00:00:00Z"), metadata: { tags: [hidden] } },
    { documentId: foreign.id, projectId: other.id, content: hidden,
      createdAt: new Date("2026-01-03T00:00:00Z"), metadata: { tags: [hidden] } },
  ] });

  const response = await read("graph", { scope: "shared" });
  assert.equal(response.status, 200, await response.clone().text());
  const graph = await response.json();
  assert.ok(graph.edges.some((edge: { fromEntityId: string; toEntityId: string }) =>
    edge.fromEntityId === `tag:${machineTag}` && edge.toEntityId === `document:${current.id}`),
  "the default graph must show the recently published machine tag even when older chunks sort first by ID");
  assert.ok(!JSON.stringify(graph).includes(hidden));
});

run("the project views read live graph provenance and separate recorded vector models", async (t) => {
  const { db, read, project, other } = await fixture(t);
  const projects = await read("projects", {});
  assert.equal(projects.status, 200);
  const projectList = await projects.json();
  assert.ok(projectList.projects.some(({ id }: { id: string }) => id === project.id));
  assert.ok(!projectList.projects.some(({ id }: { id: string }) => id === other.id));
  assert.equal((await read("overview", { project: other.id })).status, 404);
  assert.equal((await read("graph", {})).status, 400);
  assert.equal((await read("graph", { project: project.id, q: "a".repeat(121) })).status, 400);

  // Real documents and vectors: orthogonal A/B, another model, an unlabelled vector, and a parent chunk.
  const source = await db.source.create({ data: { name: "Knowledge", type: "text", status: "READY", projectId: project.id } });
  // Imported records can refer to the right project ID while still belonging to another organization.
  const foreignSource = await db.source.create({ data: { name: hidden, type: "text", status: "READY", projectId: project.id, orgId: other.orgId } });
  await db.memory.createMany({ data: [
    { projectId: project.id, orgId: project.orgId, content: "Project memory" },
    { projectId: project.id, orgId: other.orgId, content: hidden },
  ] });
  const scope = await db.repoIndexScope.create({ data: {
    projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: "/fixture",
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1", state: "withdrawn",
  } });
  const withdrawn = await db.source.create({ data: { name: `repo-index:${scope.id}`, type: "repo_index", status: "READY", projectId: project.id } });
  const foreignScope = await db.repoIndexScope.create({ data: {
    orgId: other.orgId, projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: "/fixture",
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1",
  } });
  const foreignMirror = await db.source.create({ data: { name: `repo-index:${foreignScope.id}`, type: "repo_index", status: "READY", projectId: project.id } });
  const input = [
    { title: "Anchor A", x: 1, y: 0, model: "e5", sourceId: source.id },
    { title: "Anchor B", x: 0, y: 1, model: "e5", sourceId: source.id },
    { title: "Other model", x: -1, y: 0, model: "different", sourceId: source.id },
    { title: "Unlabelled", x: 0, y: -1, model: null, sourceId: source.id },
    { title: "Missing embedding", x: 0, y: 0, model: null, sourceId: source.id },
    { title: hidden, x: -1, y: 1, model: "e5", sourceId: withdrawn.id },
    { title: hidden, x: -1, y: 1, model: "e5", sourceId: foreignSource.id },
    { title: hidden, x: -1, y: 1, model: "e5", sourceId: foreignMirror.id },
  ];
  const chunkIds: string[] = [];
  for (const [index, row] of input.entries()) {
    const document = await db.document.create({ data: { title: row.title, sourceId: row.sourceId, projectId: project.id, status: "READY" } });
    const chunk = await db.chunk.create({ data: {
      documentId: document.id, projectId: project.id, content: hidden,
      createdAt: new Date(Date.UTC(2026, 0, 20 - index)), metadata: row.model ? { embedding_model: row.model, private: hidden } : {},
    } });
    if (row.x || row.y) await db.$executeRaw`UPDATE chunks SET embedding = ${vector(row.x, row.y)}::vector WHERE id = ${chunk.id}`;
    chunkIds.push(chunk.id);
  }
  const [root] = await db.document.findMany({ where: { sourceId: source.id, title: "Anchor A" }, select: { id: true } });
  await db.chunk.create({ data: { documentId: root.id, projectId: project.id, content: hidden, metadata: { content_kind: "parent_context" } } });

  const node = async (name: string, projectId: string, isManual: boolean) => db.entity.create({
    data: { name, type: "concept", entityType: "concept", projectId, isManual, description: hidden },
  });
  const reader = await node("Reader", project.id, true);
  const index = await node("Index", project.id, true);
  const retired = await node(hidden, project.id, false);
  const foreign = await node(hidden, other.id, true);
  await db.entityMention.create({ data: { entityId: retired.id, chunkId: chunkIds[5] } });
  await db.entityMention.createMany({ data: chunkIds.slice(6).map((chunkId) => ({ entityId: retired.id, chunkId })) });
  const edge = await db.entityRelation.create({
    data: { projectId: project.id, fromEntityId: reader.id, toEntityId: index.id, relationType: "references", isManual: true },
    select: { id: true },
  });
  await db.entityRelation.create({
    data: { projectId: project.id, fromEntityId: reader.id, toEntityId: foreign.id, relationType: "references", isManual: true },
    select: { id: true },
  });

  await refreshStatistics();
  const { countsAsOf, ...overview } = await (await read("overview")).json();
  assert.ok(Number.isFinite(Date.parse(countsAsOf)));
  assert.deepEqual(overview, { documents: 5, chunks: 5, sources: 1, embedded: 4, memories: 1, entities: 2, models: [
    { model: "e5", count: 2 }, { model: "different", count: 1 }, { model: null, count: 1 },
  ] });

  const graph = await (await read("graph", { project: project.id, q: "reader" })).json();
  assert.deepEqual(new Set(graph.nodes.map(({ label }: { label: string }) => label)), new Set(["Reader", "Index"]));
  assert.deepEqual(graph.edges.map((item: { id: string; fromEntityId: string; toEntityId: string }) => [item.id, item.fromEntityId, item.toEntityId]), [[edge.id, reader.id, index.id]]);
  assert.ok(!JSON.stringify(graph).includes(hidden));
  assert.deepEqual((await (await read("graph", { project: project.id, q: hidden })).json()).nodes, []);
  assert.deepEqual((await (await read("graph", { project: project.id, q: "nonexistent" })).json()).nodes, []);

  const vectors = await (await read("vectors")).json();
  assert.equal(vectors.model, "e5");
  const points = vectors.points.map(({ label, x, y }: { label: string; x: number; y: number }) => [label, x, y]);
  assert.deepEqual(points, [["Anchor A", 1, 0], ["Anchor B", 0, 1]]);
  assert.ok(!JSON.stringify(vectors).includes(hidden));
  assert.ok(vectors.points.every((point: object) => !("embedding" in point)));
  const different = await (await read("vectors", { project: project.id, model: "different" })).json();
  assert.deepEqual(different.points.map(({ label }: { label: string }) => label), ["Other model"]);
  assert.equal((await read("vectors", { project: project.id, model: "not-stored" })).status, 404);
});

run("normal learn plots vectors under the inference model, not the document metadata", async (t) => {
  const { project, read } = await fixture(t, (text) => text.includes("recorded") ? "fixture/document-model" : undefined);
  const { api } = await import("../src/api/routes.js");
  // Exercise the production ingest route; only the upstream inference and sign-in responses are fixtures.
  for (const [title, content] of [["Runbook", "A recorded procedure for restoring a snapshot."], ["Unlabelled note", "Review snapshots before restoring them."]]) {
    const response = await api.request("/v1/learn", {
      method: "POST", headers: { Authorization: ["Bearer", apiKey].join(" "), "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "text", project: project.id, title, content, metadata: { embedding_model: "not-the-model" }, options: { async: false, ingestion_profile: "plain_text", strategy_override: "fixed" } }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).status, "completed");
  }
  await refreshStatistics();
  const overview = await (await read("overview")).json();
  assert.equal(overview.embedded, 2);
  assert.deepEqual(overview.models, [{ model: "fixture/document-model", count: 1 }, { model: null, count: 1 }]);
  const vectors = await (await read("vectors")).json();
  assert.deepEqual(vectors.points.map(({ label }: { label: string }) => label), ["Runbook"]);
});

run("client-supplied embeddings retain their model in the dashboard after batch learning", async (t) => {
  const { project, read } = await fixture(t);
  const { api } = await import("../src/api/routes.js");
  // Use the actual batch route and a model that differs from the inference service and document metadata.
  const response = await api.request("/v1/learn/batch", {
    method: "POST", headers: { Authorization: ["Bearer", apiKey].join(" "), "Content-Type": "application/json" },
    body: JSON.stringify({ project: project.id, items: [{
      type: "text", title: "Local runbook", content: "A short runbook for recovering a checkpoint.",
      embedding: coordinates(1, 0), embedding_model: "fixture/client-model", metadata: { embedding_model: "not-the-model" },
    }] }),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const batch = await response.json();
  assert.equal(batch.failed, 0, JSON.stringify(batch.items));
  assert.equal(batch.items[0]?.status, "completed");
  await refreshStatistics();
  const overview = await (await read("overview")).json();
  assert.equal(overview.embedded, 1);
  assert.deepEqual(overview.models, [{ model: "fixture/client-model", count: 1 }]);
  const vectors = await (await read("vectors")).json();
  assert.deepEqual(vectors.points.map(({ label }: { label: string }) => label), ["Local runbook"]);
});

run("repository publication makes its materialised vectors visible under their inference model", async (t) => {
  const { db, project, read } = await fixture(t, () => "fixture/repository-model");
  const { openAttempt, putPart, finalizeAttempt } = await import("../src/engine/repo-index/store.js");
  const { id: scopeId } = await db.repoIndexScope.create({ data: {
    projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: "/fixture",
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1",
  } });
  const attemptId = randomUUID();
  const path = "runbook.md";
  const content = "# Recovery\nVerify the snapshot before restoring service.";
  const digest = createHash("sha256").update(content).digest("hex");
  // Publish through the normal store rather than seeding the chunk or its metadata by hand.
  const opened = await openAttempt({ scopeId, attemptId, baseGeneration: 0, revision: 1, manifestDigest: digest, partCount: 1 });
  assert.equal(opened.code, "ATTEMPT_OPEN");
  assert.equal((await putPart({ scopeId, attemptId, partNo: 1, part: { upserts: [path], tombstones: [] } })).code, "PART_ACCEPTED");
  const published = await finalizeAttempt({ scopeId, attemptId, requiredPaths: [path], readContent: async () => content,
    manifest: { digest, dimensions: 1024, entries: [{ path, digest, vector: coordinates(0, 1) }] },
  });
  assert.equal(published.code, "PUBLISHED");
  await refreshStatistics();
  const vectors = await (await read("vectors")).json();
  assert.equal(vectors.model, "fixture/repository-model");
  assert.deepEqual(vectors.points.map(({ label }: { label: string }) => label), [path]);
});

run("the queue reflects persisted server jobs and capture retries without exposing their payloads", async (t) => {
  const { db, project, other, read } = await fixture(t);
  const empty = await (await read("queue")).json();
  assert.deepEqual(empty, { totals: [], jobs: [] });

  const job = randomUUID();
  await db.$executeRaw`INSERT INTO ingestion_jobs (id, org_id, project_id, user_id, status, total_documents, processed_documents, error)
    VALUES (${job}, 'default', ${project.id}, ${hidden}, 'PROCESSING', 4, 2, ${hidden}),
           (${randomUUID()}, 'default', ${other.id}, ${hidden}, 'FAILED', 99, 0, ${hidden}),
           (${randomUUID()}, ${other.orgId}, ${project.id}, ${hidden}, 'FAILED', 99, 0, ${hidden})`;
  const source = await db.source.create({ data: { name: "Sync", type: "text", projectId: project.id } });
  await db.syncJob.create({ data: { sourceId: source.id, status: "PENDING", errorMessage: hidden, logs: [hidden] } });
  const foreignSource = await db.source.create({ data: { name: hidden, type: "text", projectId: project.id, orgId: other.orgId } });
  await db.syncJob.create({ data: { sourceId: foreignSource.id, status: "FAILED", documentsTotal: 99 } });
  const scope = await db.repoIndexScope.create({ data: {
    projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: hidden,
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1",
  } });
  const generation = await db.repoIndexGeneration.create({ data: {
    scopeId: scope.id, attemptId: "fixture", baseGeneration: 0, generation: 1, revision: "fixture", manifestDigest: hidden,
    status: "open", partCount: 3,
  } });
  await db.repoIndexPart.create({ data: { generationId: generation.id, partNo: 0, requestHash: hidden } });
  const foreignScope = await db.repoIndexScope.create({ data: {
    orgId: other.orgId, projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: hidden,
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1",
  } });
  await db.repoIndexGeneration.create({ data: {
    scopeId: foreignScope.id, attemptId: "fixture", baseGeneration: 0, generation: 1, revision: "fixture", manifestDigest: hidden,
    status: "failed", partCount: 99,
  } });

  // Native hooks persist queue state in a message. Ordinary chat and other projects are not jobs here.
  const session = await db.session.create({ data: { projectId: project.id, orgId: project.orgId, sessionId: randomUUID() } });
  const foreignSession = await db.session.create({ data: { projectId: other.id, orgId: other.orgId, sessionId: randomUUID() } });
  t.after(async () => { await db.session.deleteMany({ where: { id: { in: [session.id, foreignSession.id] } } }); });
  const event = await db.message.create({ data: {
    sessionId: session.id, role: "event", content: hidden,
    metadata: { source: "native_agent_hook", native_capture_state: "pending", last_error: hidden },
  } });
  await db.message.create({ data: {
    sessionId: session.id, role: "user", content: hidden, metadata: { native_capture_state: "pending" },
  } });
  await db.message.create({ data: {
    sessionId: foreignSession.id, role: "event", content: hidden,
    metadata: { source: "native_agent_hook", native_capture_state: "failed" },
  } });
  const queue = await read("queue");
  assert.equal(queue.status, 200);
  const text = await queue.text();
  assert.ok(!text.includes(hidden));
  const state = JSON.parse(text);
  assert.deepEqual(state.totals, [
    { kind: "Ingestion", status: "PROCESSING", count: 1 },
    { kind: "Native capture", status: "pending", count: 1 },
    { kind: "Repository index", status: "open", count: 1 },
    { kind: "Source sync", status: "PENDING", count: 1 },
  ]);
  const row = state.jobs.find(({ id }: { id: string }) => id === job);
  assert.deepEqual([row.kind, row.status, row.processed, row.total], ["Ingestion", "PROCESSING", 2, 4]);
  const repo = state.jobs.find(({ id }: { id: string }) => id === generation.id);
  assert.deepEqual([repo.kind, repo.status, repo.processed, repo.total], ["Repository index", "open", 1, 3]);

  await db.$executeRaw`UPDATE ingestion_jobs SET status = 'COMPLETED', processed_documents = 4 WHERE id = ${job}`;
  await db.message.update({ where: { id: event.id }, data: { metadata: { source: "native_agent_hook", native_capture_state: "indexed" } } });
  const updated = await (await read("queue")).json();
  assert.ok(updated.jobs.some((entry: { id: string; status: string; processed: number }) => entry.id === job && entry.status === "COMPLETED" && entry.processed === 4));
  const { createdAt, ...capture } = updated.jobs.find(({ id }: { id: string }) => id === event.id);
  assert.equal(Date.parse(createdAt), event.createdAt.getTime());
  assert.deepEqual(capture, {
    id: event.id, kind: "Native capture", status: "indexed",
    processed: 1, total: 1, unit: "event", project: project.name,
  });
});

run("the All projects queue aggregates authorized jobs and keeps project labels", async (t) => {
  const { db, project, other, read } = await fixture(t);
  const sibling = await db.project.create({ data: { name: "Sibling queue", slug: `${project.slug}-sibling` } });
  t.after(async () => {
    await db.$executeRaw`DELETE FROM ingestion_jobs WHERE project_id = ${sibling.id}`;
    await db.project.delete({ where: { id: sibling.id } });
  });
  const first = randomUUID(), second = randomUUID(), foreign = randomUUID(), mislabelled = randomUUID();
  // Two authorized projects, plus mismatches in each direction between project and job ownership.
  await db.$executeRaw`INSERT INTO ingestion_jobs (id, org_id, project_id, user_id, status, total_documents, processed_documents, error)
    VALUES (${first}, 'default', ${project.id}, ${hidden}, 'PROCESSING', 4, 2, ${hidden}),
           (${second}, 'default', ${sibling.id}, ${hidden}, 'PROCESSING', 1, 0, ${hidden}),
           (${foreign}, 'default', ${other.id}, ${hidden}, 'PROCESSING', 99, 0, ${hidden}),
           (${mislabelled}, ${other.orgId}, ${project.id}, ${hidden}, 'PROCESSING', 99, 0, ${hidden})`;

  const response = await read("queue", { scope: "shared" });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(hidden));
  const state = JSON.parse(text);
  assert.deepEqual(state.totals, [{ kind: "Ingestion", status: "PROCESSING", count: 2 }]);
  assert.deepEqual(new Map(state.jobs.map(({ id, project }: { id: string; project: string }) => [id, project])),
    new Map([[first, project.name], [second, sibling.name]]));
  const filtered = await (await read("queue")).json();
  assert.deepEqual(filtered.jobs.map(({ id }: { id: string }) => id), [first]);
  assert.equal((await read("queue", { scope: "shared", project: project.id })).status, 400);
});

run("queue prioritizes runnable attempts and labels paused, withdrawn, and superseded work", async (t) => {
  const { db, project, read } = await fixture(t);
  const open = await db.repoIndexScope.create({ data: {
    projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: "/active",
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1", activeGeneration: 3,
  } });
  const paused = await db.repoIndexScope.create({ data: {
    projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: "/paused",
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1", state: "paused",
  } });
  const withdrawn = await db.repoIndexScope.create({ data: {
    projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: "/withdrawn",
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1", state: "withdrawn",
  } });
  const active = await db.repoIndexGeneration.create({ data: {
    scopeId: open.id, attemptId: "next", baseGeneration: 3, generation: 4, status: "open",
    revision: "fixture", manifestDigest: hidden, partCount: 1, createdAt: new Date("2026-01-01T00:00:00Z"),
  } });
  const ids = Array.from({ length: 50 }, () => randomUUID());
  await db.repoIndexGeneration.createMany({ data: ids.map((id, index) => ({
    id, scopeId: [open.id, paused.id, withdrawn.id][index % 3], attemptId: id,
    baseGeneration: 0, generation: 5 + index, status: index % 2 ? "open" : "sealed",
    revision: "fixture", manifestDigest: hidden, partCount: 1, createdAt: new Date("2026-02-01T00:00:00Z"),
  })) });

  // Newer blocked rows must not hide the project’s only runnable attempt at the table limit.
  const queue = await (await read("queue")).json();
  assert.equal(queue.jobs.length, 50);
  assert.equal(queue.jobs[0].id, active.id);
  assert.deepEqual(queue.totals, [
    { kind: "Repository index", status: "blocked", count: 33 },
    { kind: "Repository index", status: "open", count: 1 },
    { kind: "Repository index", status: "superseded", count: 17 },
  ]);
});

run("administrator rebuilds repair missing knowledge without replacing stored workstation vectors", async (t) => {
  const { db, project, other, read } = await fixture(t, () => "fixture/rebuild");
  const { createNodeApp } = await import("../src/api/app.js");
  const app = createNodeApp({ includeApiRoutes: false });
  const enqueue = (body: object, session = "fixture-admin", from = origin) => app.request(`${origin}/dashboard/rebuilds`, {
    method: "POST", headers: { cookie: `authelia_session=${session}`, origin: from, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const body = { kind: "knowledge", project: project.id };
  assert.equal((await enqueue(body, "fixture-session")).status, 403);
  assert.equal((await enqueue(body, "fixture-admin", "https://unrelated.example.test")).status, 403);
  assert.equal((await enqueue({ kind: "knowledge", project: other.id })).status, 404);
  assert.equal((await enqueue({ ...body, scope: "shared" })).status, 400);

  // Only the missing vector is repaired; original content and workstation provenance survive.
  const source = await db.source.create({ data: { name: "Rebuild input", type: "text", projectId: project.id } });
  const document = await db.document.create({ data: { title: "Repair", sourceId: source.id, projectId: project.id, status: "READY" } });
  const missing = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, content: "Needs repair", metadata: { fixture: true } } });
  const existing = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, content: "Already searchable", metadata: { embedding_model: "fixture/workstation" } } });
  await db.$executeRaw`UPDATE chunks SET embedding = ${vector(0, 1)}::vector WHERE id = ${existing.id}`;

  const queued = await enqueue(body);
  assert.equal(queued.status, 202);
  const { id } = await queued.json();
  assert.equal((await enqueue({ kind: "knowledge", scope: "shared" })).status, 409);
  // A replacement worker must honor a live lease and reclaim an interrupted batch after expiry.
  await db.$executeRaw`UPDATE dashboard_rebuilds SET status = 'running', lease_token = 'interrupted-worker',
    lease_until = now() + interval '1 minute' WHERE id = ${id}`;
  const { runDashboardRebuildBatch } = await import("../src/engine/dashboard-rebuild.js");
  await runDashboardRebuildBatch();
  const [beforeRecovery] = await db.$queryRaw<{ missing: boolean }[]>`SELECT embedding IS NULL AS missing FROM chunks WHERE id = ${missing.id}`;
  assert.equal(beforeRecovery.missing, true);
  await db.$executeRaw`UPDATE dashboard_rebuilds SET lease_until = now() - interval '1 second' WHERE id = ${id}`;
  await runDashboardRebuildBatch();
  const [prepared] = await db.$queryRaw<{ missing: boolean }[]>`SELECT embedding IS NULL AS missing FROM chunks WHERE id = ${missing.id}`;
  assert.equal(prepared.missing, true, "prepared embeddings must not be visible before the job completes");
  await runDashboardRebuildBatch();
  const jobs = await (await read("queue")).json();
  const job = jobs.jobs.find((item: { id: string }) => item.id === id);
  assert.deepEqual([job.status, job.processed, job.total], ["completed", 1, 1]);
  const rows = await db.$queryRaw<{ id: string; content: string; metadata: object; matches: boolean }[]>`
    SELECT id, content, metadata, embedding = (CASE WHEN id = ${missing.id} THEN ${vector(1, 0)} ELSE ${vector(0, 1)} END)::vector AS matches
    FROM chunks WHERE id IN (${missing.id}, ${existing.id})`;
  assert.deepEqual(rows.find(({ id }) => id === missing.id), {
    id: missing.id, content: "Needs repair", metadata: { fixture: true, embedding_model: "fixture/rebuild" }, matches: true,
  });
  assert.deepEqual(rows.find(({ id }) => id === existing.id), {
    id: existing.id, content: "Already searchable", metadata: { embedding_model: "fixture/workstation" }, matches: true,
  });
});

run("a knowledge rebuild with a stalled provider releases its slot without publishing late vectors", async (t) => {
  const { db, project, read } = await fixture(t, () => "fixture/rebuild");
  const { createNodeApp } = await import("../src/api/app.js");
  const { runDashboardRebuildBatch } = await import("../src/engine/dashboard-rebuild.js");
  const app = createNodeApp({ includeApiRoutes: false });
  const enqueue = () => app.request(`${origin}/dashboard/rebuilds`, {
    method: "POST", headers: { cookie: "authelia_session=fixture-admin", origin, "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "knowledge", project: project.id }),
  });
  const source = await db.source.create({ data: { name: "Slow rebuild input", type: "text", projectId: project.id } });
  const document = await db.document.create({ data: { title: "Slow rebuild", sourceId: source.id, projectId: project.id, status: "READY" } });
  const chunk = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, content: "Needs a vector" } });
  const queued = await enqueue();
  assert.equal(queued.status, 202);
  const { id } = await queued.json();

  // Shorten only the worker deadline. Keep the DB lease and HTTP entry points real.
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn: () => void, ms?: number) => originalSetTimeout(fn, ms === 60_000 ? 15 : ms));
  const normalFetch = globalThis.fetch;
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  let providerSignal: AbortSignal | undefined;
  let finishResponse!: () => void;
  const lateResponse = new Promise<void>(resolve => { finishResponse = resolve; });
  let holdProvider = true;
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    if (holdProvider && String(url) === `${inferenceUrl}/v1/inference/embeddings`) {
      providerSignal = init?.signal ?? undefined;
      await stalled;
      const response = await normalFetch(url, init);
      finishResponse();
      return response;
    }
    return normalFetch(url, init);
  });

  const batch = runDashboardRebuildBatch();
  let safeguard: ReturnType<typeof setTimeout> | undefined;
  try {
    // Prevent RED from hanging when the old worker has no deadline.
    assert.equal(await Promise.race([batch.then(() => "settled"), new Promise(resolve => {
      safeguard = originalSetTimeout(() => resolve("still waiting for provider"), 750);
    })]), "settled");
    assert.equal(providerSignal?.aborted, true);
    const queue = await (await read("queue")).json();
    const job = queue.jobs.find((item: { id: string }) => item.id === id);
    assert.deepEqual([job.status, job.processed], ["failed", 0]);
    assert.match(job.error, /timed out/);
  } finally {
    clearTimeout(safeguard);
    release();
    await batch;
  }
  await lateResponse;
  const [late] = await db.$queryRaw<{ missing: boolean }[]>`SELECT embedding IS NULL AS missing FROM chunks WHERE id = ${chunk.id}`;
  assert.equal(late.missing, true);
  holdProvider = false;
  const retry = await enqueue();
  assert.equal(retry.status, 202);
  const retryId = (await retry.json()).id;
  await runDashboardRebuildBatch();
  await runDashboardRebuildBatch();
  const finalQueue = await (await read("queue")).json();
  const completed = finalQueue.jobs.find((item: { id: string }) => item.id === retryId);
  assert.deepEqual([completed.status, completed.processed], ["completed", 1]);
});

run("shared graph rebuild publishes chunk-derived relations and preserves manual knowledge", async (t) => {
  const { db, project, other, read } = await fixture(t);
  let failure: "transport" | "incomplete" | undefined;
  let omitPreviousRelation = false;
  let failSecondChunk = false;
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async ({ messages }: { messages: { content: string }[] }) => {
    if (failure === "transport") throw new Error("fixture-private-provider-response");
    if (failure === "incomplete") return {
      choices: [{ finish_reason: "length", message: { content: '{"entities":[],"relations":[]}' } }],
    };
    if (messages[0].content.includes("Second eligible dashboard chunk")) {
      if (failSecondChunk) throw new Error("second fixture batch failed");
      return { choices: [{ finish_reason: "stop", message: { content: '{"entities":[],"relations":[]}' } }] };
    }
    assert.match(messages[0].content, /Rebuild Alpha depends on Rebuild Beta/);
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      entities: [{ name: "Rebuild Alpha", type: "service" }, { name: omitPreviousRelation ? "Rebuild Gamma" : "Rebuild Beta", type: "service" }],
      relations: omitPreviousRelation
        ? [{ from: "Rebuild Alpha", fromType: "service", to: "Rebuild Gamma", toType: "service", relation: "references" }]
        : [{ from: "Rebuild Alpha", fromType: "service", to: "Rebuild Beta", toType: "service", relation: "depends_on" }],
    }) } }] };
  });
  const { createNodeApp } = await import("../src/api/app.js");
  const app = createNodeApp({ includeApiRoutes: false });
  const headers = { cookie: "authelia_session=fixture-admin", origin, "Content-Type": "application/json" };
  const jobs: string[] = [];
  // Shared jobs have no project FK to cascade when the project fixture is removed.
  t.after(async () => { await db.$executeRaw`DELETE FROM dashboard_rebuilds WHERE id = ANY(${jobs}::text[])`; });
  const enqueue = async () => {
    const response = await app.request(`${origin}/dashboard/rebuilds`, { method: "POST", headers, body: JSON.stringify({ kind: "graph", scope: "shared" }) });
    if (response.status === 202) jobs.push((await response.clone().json()).id);
    return response;
  };
  assert.equal((await enqueue()).status, 503);
  for (const [key, value] of Object.entries({ EXTRACTION_MODEL: "fixture/graph", OPENAI_BASE_URL: "https://extraction.example.test/v1", OPENAI_API_KEY: "fixture-only-key" })) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }

  // A foreign chunk must never reach extraction, even when using All projects.
  for (const [owner, text] of [[project, "Rebuild Alpha depends on Rebuild Beta. Rebuild Alpha references Rebuild Gamma."], [other, hidden]] as const) {
    const source = await db.source.create({ data: { name: "Graph source", type: "text", projectId: owner.id, orgId: owner.orgId } });
    const document = await db.document.create({ data: { title: text, sourceId: source.id, projectId: owner.id, status: "READY" } });
    await db.chunk.create({ data: { id: `${owner.id}-a`, documentId: document.id, projectId: owner.id, content: text } });
    if (owner.id === project.id) await db.chunk.create({ data: {
      id: `${owner.id}-b`, documentId: document.id, projectId: owner.id, content: "Second eligible dashboard chunk",
    } });
  }
  const manual = await db.entity.create({ data: { name: "Manual entry", type: "concept", projectId: project.id, isManual: true } });
  const queued = await enqueue();
  assert.equal(queued.status, 202);
  const { id } = await queued.json();
  const { runDashboardRebuildBatch } = await import("../src/engine/dashboard-rebuild.js");
  await runDashboardRebuildBatch();
  const building = await (await read("graph", { scope: "shared", q: "Rebuild Alpha" })).json();
  assert.deepEqual(building.edges, [], "a prepared graph batch must not affect the serving graph");
  await runDashboardRebuildBatch();
  await runDashboardRebuildBatch();
  const queue = await (await read("queue", { scope: "shared" })).json();
  const job = queue.jobs.find((item: { id: string }) => item.id === id);
  assert.deepEqual([job?.status, job?.processed, job?.total], ["completed", 2, 2], job?.error);
  const graph = await (await read("graph", { scope: "shared", q: "Rebuild Alpha" })).json();
  assert.deepEqual(graph.nodes.map((node: { label: string }) => node.label).sort(), ["Rebuild Alpha", "Rebuild Beta"]);
  assert.deepEqual(graph.edges.map((edge: { relationType: string }) => edge.relationType), ["depends_on"]);
  assert.equal((await db.entity.findUniqueOrThrow({ where: { id: manual.id } })).isManual, true);

  // A non-final response can contain valid JSON; it must not replace the serving graph.
  for (failure of ["transport", "incomplete"] as const) {
    const retry = await enqueue();
    assert.equal(retry.status, 202);
    const failedId = (await retry.json()).id;
    await runDashboardRebuildBatch();
    const failedQueue = await (await read("queue", { scope: "shared" })).json();
    const failed = failedQueue.jobs.find((item: { id: string }) => item.id === failedId);
    assert.deepEqual([failed.status, failed.processed], ["failed", 0], failure);
    assert.match(failed.error, /Check the configured extraction provider/);
    assert.doesNotMatch(JSON.stringify(failed), /fixture-private-provider-response/);
    const serving = await (await read("graph", { scope: "shared", q: "Rebuild Alpha" })).json();
    assert.deepEqual(serving.edges, graph.edges, failure);
  }

  // A successful response can add evidence but omission is not evidence of deletion.
  failure = undefined;
  omitPreviousRelation = true;
  failSecondChunk = true;
  const lateFailure = await enqueue();
  assert.equal(lateFailure.status, 202);
  const lateFailureId = (await lateFailure.json()).id;
  await runDashboardRebuildBatch();
  await runDashboardRebuildBatch();
  const lateFailureQueue = await (await read("queue", { scope: "shared" })).json();
  assert.equal(lateFailureQueue.jobs.find((item: { id: string }) => item.id === lateFailureId).status, "failed");
  const unchanged = await (await read("graph", { scope: "shared", q: "Rebuild Alpha" })).json();
  assert.deepEqual(unchanged, graph, "a later provider failure must not publish earlier claims");

  failSecondChunk = false;
  const stale = await enqueue();
  assert.equal(stale.status, 202);
  const staleId = (await stale.json()).id;
  await runDashboardRebuildBatch();
  await runDashboardRebuildBatch();
  // Changing the last staged input forces a failure during publication, after the first apply.
  await db.chunk.update({ where: { id: `${project.id}-b` }, data: { content: "Second eligible dashboard chunk changed" } });
  await runDashboardRebuildBatch();
  const staleJob = (await (await read("queue", { scope: "shared" })).json()).jobs.find((item: { id: string }) => item.id === staleId);
  assert.equal(staleJob.status, "failed");
  assert.match(staleJob.error, /Indexed content changed/);
  assert.deepEqual(await (await read("graph", { scope: "shared", q: "Rebuild Alpha" })).json(), graph);

  const repair = await enqueue();
  assert.equal(repair.status, 202);
  const repairId = (await repair.json()).id;
  await runDashboardRebuildBatch();
  await runDashboardRebuildBatch();
  await runDashboardRebuildBatch();
  const merged = await (await read("graph", { scope: "shared", q: "Rebuild Alpha" })).json();
  assert.deepEqual(merged.edges.map((edge: { relationType: string }) => edge.relationType).sort(), ["depends_on", "references"]);
  assert.deepEqual(await db.$queryRaw`SELECT job_id FROM dashboard_rebuild_items
    WHERE job_id IN (${id}, ${lateFailureId}, ${staleId}, ${repairId})`, []);
});

runBrowser("a browser can inspect knowledge, switch projects and refresh activity", { timeout: 30_000 }, async (t) => {
  const { db, project } = await fixture(t);
  const { createNodeApp } = await import("../src/api/app.js");
  await db.entity.create({ data: { name: "<em>Reader</em>", type: "concept", projectId: project.id, isManual: true } });
  let app: ReturnType<typeof createNodeApp>;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    // The fixture uses loopback HTTP instead of the production TLS ingress.
    if (request.headers.get("origin") === new URL(request.url).origin) {
      request.headers.set("origin", new URL(request.url).origin.replace("http:", "https:"));
    }
    return app.fetch(request);
  } });
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  process.env.RETAINDB_DASHBOARD_ORIGIN = base.replace("http:", "https:");
  app = createNodeApp({ includeApiRoutes: false });
  const browser = await chromium.launch({ channel: process.env.RETAINDB_TEST_CHROME_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().addCookies([{ name: "authelia_session", value: "fixture-session", url: base }]);

  // Exercise the shipped page through the same HTTP routes as a signed-in browser.
  const response = await page.goto(`${base}/dashboard`);
  assert.equal(response?.status(), 200);
  await page.getByText("Read-only", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Rebuild knowledge" }).count(), 0);
  // Signing in as an admin changes the actual page, not just the API response.
  await page.context().addCookies([{ name: "authelia_session", value: "fixture-admin", url: base }]);
  await page.reload();
  await page.getByText("Administrator", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.getByText("Entities", { exact: true }).waitFor();
  await page.getByText("Counts as of", { exact: false }).waitFor();
  const selector = page.getByLabel("Project", { exact: true });
  assert.equal(await selector.locator("option:checked").textContent(), "All projects");
  // A failed refresh must preserve the last result for this scope, but not for a different project.
  const overviewRoute = "**/dashboard/data/overview?*";
  await page.route(overviewRoute, (route) => route.fulfill({ status: 503 }));
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByText("RetainDB could not load this view. Try Refresh.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Entities", { exact: true }).count(), 1);
  assert.match(await page.locator("#updated").textContent() ?? "", /^Updated .+ · Previous result$/);
  await selector.selectOption(project.id);
  await page.getByText("RetainDB could not load this view. Try Refresh.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Entities", { exact: true }).count(), 0);
  await page.unroute(overviewRoute);
  await selector.selectOption("");
  await page.getByText("Entities", { exact: true }).waitFor();
  await page.route(overviewRoute, (route) => route.fulfill({ status: 401 }));
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByText("Your session expired. Reload the page to sign in again.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Entities", { exact: true }).count(), 0);
  assert.equal(await page.locator("#updated").textContent(), "");
  await page.unroute(overviewRoute);
  const nav = page.getByRole("navigation", { name: "Dashboard views" });
  await nav.getByRole("link", { name: "Knowledge graph" }).click();
  await page.getByRole("button", { name: "<em>Reader</em>", exact: true }).click();
  await page.getByRole("status", { name: "Selected item" }).filter({ hasText: `Project: ${project.name}` }).waitFor();
  await selector.selectOption(project.id);
  await nav.getByRole("link", { name: "Knowledge graph" }).click();
  await page.getByRole("button", { name: "<em>Reader</em>", exact: true }).click();
  await page.getByRole("status", { name: "Selected item" }).filter({ hasText: "<em>Reader</em>" }).waitFor();
  assert.equal(await page.locator("em").count(), 0);
  await page.keyboard.press("Escape");
  await page.getByText("Select an item to inspect it.").waitFor();
  await nav.getByRole("link", { name: "Vector map" }).click();
  await page.getByText("No labelled embeddings in this project.").waitFor();
  const source = await db.source.create({ data: { name: "Browser knowledge", type: "text", projectId: project.id } });
  for (const [label, model, coords] of [["Blueprint", "e5", [[1, 0], [0, 1]]], ["Checklist", "other", [[0, 1]]]] as const) {
    const document = await db.document.create({ data: { title: label, sourceId: source.id, projectId: project.id, status: "READY" } });
    for (const [chunkIndex, [x, y]] of coords.entries()) {
      const chunk = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, chunkIndex, content: hidden, metadata: { embedding_model: model } } });
      await db.$executeRaw`UPDATE chunks SET embedding = ${vector(x, y)}::vector WHERE id = ${chunk.id}`;
    }
  }
  // The default graph exposes source tags as selectable nodes even without extracted entities for the documents.
  await nav.getByRole("link", { name: "Knowledge graph" }).click();
  await page.getByRole("button", { name: `project:${project.slug}`, exact: true }).click();
  const tagDetails = page.getByRole("status", { name: "Selected item" });
  await tagDetails.getByText(`Search tag: project:${project.slug}`, { exact: true }).waitFor({ timeout: 2500 });
  await tagDetails.getByText("tags → Blueprint", { exact: true }).waitFor({ timeout: 2500 });
  await refreshStatistics();
  await nav.getByRole("link", { name: "Vector map" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  const chunks = page.getByRole("complementary").getByRole("button", { name: /^Blueprint/ });
  await chunks.nth(1).waitFor();
  assert.deepEqual((await chunks.allTextContents()).sort(), ["Blueprint · chunk 1", "Blueprint · chunk 2"]);
  await page.getByRole("button", { name: "Blueprint · chunk 2", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("status", { name: "Selected item" }).filter({ hasText: "Blueprint · chunk 2" }).waitFor();
  await page.getByText(/^Similarity to A: [01]\.000$/).waitFor();
  await page.getByLabel("Embedding model").selectOption("other");
  await page.getByRole("button", { name: "Checklist · chunk 1", exact: true }).waitFor();
  assert.equal(await chunks.count(), 0);

  // An old bookmark should still let you switch models after reindexing.
  await db.$executeRaw`UPDATE chunks SET metadata = '{}'::jsonb WHERE "projectId" = ${project.id} AND metadata->>'embedding_model' = 'other'`;
  await refreshStatistics();
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: "Show available models" }).click({ timeout: 2500 });
  await page.getByRole("button", { name: "Blueprint · chunk 1", exact: true }).waitFor();

  await nav.getByRole("link", { name: "Queue" }).click();
  await page.getByText("No jobs in this view.").waitFor();
  await nav.getByRole("link", { name: "Overview" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Rebuild knowledge" }).click({ timeout: 2500 });
  await nav.getByRole("link", { name: "Queue" }).click();
  await page.getByText("No jobs in this view.").waitFor();
  await nav.getByRole("link", { name: "Overview" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Rebuild knowledge" }).click({ timeout: 2500 });
  await page.getByRole("row").filter({ hasText: "Knowledge rebuild" }).getByText("queued", { exact: true }).waitFor();
  const { runDashboardRebuildBatch } = await import("../src/engine/dashboard-rebuild.js");
  await runDashboardRebuildBatch();
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("row").filter({ hasText: "Knowledge rebuild" }).getByText("completed", { exact: true }).waitFor();
  const queuedSync = await db.syncJob.create({ data: { sourceId: source.id, status: "RUNNING", documentsTotal: 3, documentsIndexed: 1 } });
  await selector.selectOption("");
  await page.getByRole("button", { name: "Refresh" }).click();
  // Mobile adds the column label to the accessible cell name.
  const sync = page.getByRole("row").filter({ hasText: queuedSync.id });
  await sync.getByText(project.name, { exact: true }).waitFor({ timeout: 3500 });
  await sync.getByText("1 / 3 documents", { exact: true }).waitFor({ timeout: 3500 });
  await page.request.get(`${base}/v1/browser-fixture`);
  await nav.getByRole("link", { name: "Logs" }).click();
  await page.getByRole("cell", { name: "Unmatched API route" }).first().waitFor();
  assert.equal(await page.getByRole("cell", { name: "Unmatched API route" }).count(), 1);
  await page.request.get(`${base}/v1/another-request`);
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("cell", { name: "Unmatched API route" }).nth(1).waitFor();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `Viewport ${width}`);
  }

  // Refresh also discovers projects created while the dashboard was already open.
  const second = await db.project.create({ data: { name: `${project.slug}-next`, slug: `${project.slug}-next` } });
  t.after(async () => { await db.project.delete({ where: { id: second.id } }); });
  await nav.getByRole("link", { name: "Knowledge graph" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await selector.selectOption(second.id, { timeout: 2500 });
  await page.getByText("No visible entities in this project.").waitFor();
  assert.equal(await page.getByRole("button", { name: "<em>Reader</em>", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});
