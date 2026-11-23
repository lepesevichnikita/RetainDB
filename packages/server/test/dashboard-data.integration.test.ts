import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const runBrowser = databaseUrl && process.env.RETAINDB_TEST_CHROME_CHANNEL ? test : test.skip;
const origin = "https://retained.example.test";
const authUrl = "https://identity.example.test/api/authz/forward-auth";
const cookie = "authelia_session=fixture-session";
const hidden = "not-visible-in-the-dashboard";
const vector = (x: number, y: number) => `[${[x, y, ...Array<number>(1022).fill(0)].join(",")}]`;

async function fixture(t: TestContext) {
  Object.assign(process.env, { DATABASE_URL: databaseUrl, RETAINDB_DASHBOARD_ORIGIN: origin, RETAINDB_DASHBOARD_AUTH_URL: authUrl });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { headers: { "Remote-User": "operator" } }));
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
  const scope = await db.repoIndexScope.create({ data: {
    projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: "/fixture",
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1", state: "withdrawn",
  } });
  const withdrawn = await db.source.create({ data: { name: `repo-index:${scope.id}`, type: "repo_index", status: "READY", projectId: project.id } });
  const input = [
    { title: "Anchor A", x: 1, y: 0, model: "e5", sourceId: source.id },
    { title: "Anchor B", x: 0, y: 1, model: "e5", sourceId: source.id },
    { title: "Other model", x: -1, y: 0, model: "different", sourceId: source.id },
    { title: "Unlabelled", x: 0, y: -1, model: null, sourceId: source.id },
    { title: "Missing embedding", x: 0, y: 0, model: null, sourceId: source.id },
    { title: hidden, x: -1, y: 1, model: "e5", sourceId: withdrawn.id },
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
  const edge = await db.entityRelation.create({
    data: { projectId: project.id, fromEntityId: reader.id, toEntityId: index.id, relationType: "references", isManual: true },
    select: { id: true },
  });
  await db.entityRelation.create({
    data: { projectId: project.id, fromEntityId: reader.id, toEntityId: foreign.id, relationType: "references", isManual: true },
    select: { id: true },
  });

  const overview = await (await read("overview")).json();
  assert.deepEqual(overview, { documents: 5, chunks: 5, sources: 1, embedded: 4, memories: 0, entities: 2, models: [
    { model: "e5", count: 2 }, { model: "different", count: 1 }, { model: null, count: 1 },
  ] });

  const graph = await (await read("graph", { project: project.id, q: "reader" })).json();
  assert.deepEqual(new Set(graph.nodes.map(({ label }: { label: string }) => label)), new Set(["Reader", "Index"]));
  assert.deepEqual(graph.edges.map((item: { id: string; fromEntityId: string; toEntityId: string }) => [item.id, item.fromEntityId, item.toEntityId]), [[edge.id, reader.id, index.id]]);
  assert.ok(!JSON.stringify(graph).includes(hidden));
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

run("the queue reflects persisted server jobs and capture retries without exposing their payloads", async (t) => {
  const { db, project, other, read } = await fixture(t);
  const empty = await (await read("queue")).json();
  assert.deepEqual(empty, { totals: [], jobs: [] });

  const job = randomUUID();
  await db.$executeRaw`INSERT INTO ingestion_jobs (id, org_id, project_id, user_id, status, total_documents, processed_documents, error)
    VALUES (${job}, 'default', ${project.id}, ${hidden}, 'PROCESSING', 4, 2, ${hidden}),
           (${randomUUID()}, 'default', ${other.id}, ${hidden}, 'FAILED', 99, 0, ${hidden})`;
  const source = await db.source.create({ data: { name: "Sync", type: "text", projectId: project.id } });
  await db.syncJob.create({ data: { sourceId: source.id, status: "PENDING", errorMessage: hidden, logs: [hidden] } });
  const scope = await db.repoIndexScope.create({ data: {
    projectId: project.id, repoHost: "example.test", repoExternalId: project.id, worktreePath: hidden,
    deviceId: "fixture", ref: "main", headCommit: "fixture", policyVersion: "1", pipelineVersion: "1",
  } });
  const generation = await db.repoIndexGeneration.create({ data: {
    scopeId: scope.id, attemptId: "fixture", baseGeneration: 0, generation: 1, revision: "fixture", manifestDigest: hidden,
    status: "open", partCount: 3,
  } });
  await db.repoIndexPart.create({ data: { generationId: generation.id, partNo: 0, requestHash: hidden } });

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
    processed: 1, total: 1, unit: "event",
  });
});

runBrowser("a browser can inspect knowledge, switch projects and refresh activity", { timeout: 30_000 }, async (t) => {
  const { db, project } = await fixture(t);
  const { createNodeApp } = await import("../src/api/app.js");
  await db.entity.create({ data: { name: "<em>Reader</em>", type: "concept", projectId: project.id, isManual: true } });
  let app: ReturnType<typeof createNodeApp>;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
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
  const response = await page.goto(`${base}/dashboard?project=${project.id}`);
  assert.equal(response?.status(), 200);
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.getByText("Entities", { exact: true }).waitFor();
  const nav = page.getByRole("navigation", { name: "Dashboard views" });
  await nav.getByRole("link", { name: "Knowledge graph" }).click();
  await page.getByRole("button", { name: "<em>Reader</em>", exact: true }).click();
  await page.getByRole("status", { name: "Selected item" }).filter({ hasText: "<em>Reader</em>" }).waitFor();
  assert.equal(await page.locator("em").count(), 0);
  await page.keyboard.press("Escape");
  await page.getByText("Select an item to inspect it.").waitFor();
  await nav.getByRole("link", { name: "Vector map" }).click();
  await page.getByText("No labelled embeddings in this project.").waitFor();
  const source = await db.source.create({ data: { name: "Browser knowledge", type: "text", projectId: project.id } });
  for (const [label, model, coords] of [["Blueprint", "e5", [1, 0]], ["Checklist", "other", [0, 1]]] as const) {
    const document = await db.document.create({ data: { title: label, sourceId: source.id, projectId: project.id, status: "READY" } });
    const chunk = await db.chunk.create({ data: { documentId: document.id, projectId: project.id, content: hidden, metadata: { embedding_model: model } } });
    await db.$executeRaw`UPDATE chunks SET embedding = ${vector(coords[0], coords[1])}::vector WHERE id = ${chunk.id}`;
  }
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: "Blueprint", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByText("Similarity to A: 1.000").waitFor();
  await page.getByLabel("Embedding model").selectOption("other");
  await page.getByRole("button", { name: "Checklist", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Blueprint", exact: true }).count(), 0);

  // An old bookmark should still let you switch models after reindexing.
  await db.$executeRaw`UPDATE chunks SET metadata = '{}'::jsonb WHERE "projectId" = ${project.id} AND metadata->>'embedding_model' = 'other'`;
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: "Show available models" }).click({ timeout: 2500 });
  await page.getByRole("button", { name: "Blueprint", exact: true }).waitFor();

  await nav.getByRole("link", { name: "Queue" }).click();
  await page.getByText("No jobs for this project.").waitFor();
  await db.syncJob.create({ data: { sourceId: source.id, status: "RUNNING", documentsTotal: 3, documentsIndexed: 1 } });
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("cell", { name: /1 \/ 3 documents/ }).waitFor();
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
  const selector = page.getByLabel("Project", { exact: true });
  await selector.selectOption(second.id, { timeout: 2500 });
  await page.getByText("No visible entities in this project.").waitFor();
  assert.equal(await page.getByRole("button", { name: "<em>Reader</em>", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});
