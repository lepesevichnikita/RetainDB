import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import OpenAI from "openai";
import postgres from "postgres";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const vector = [1, ...Array<number>(1023).fill(0)];
const inferenceUrl = "https://provenance-fixture.invalid";
const model = "provenance-fixture-model";
const credential = randomUUID();
const migrationRoot = new URL("../prisma/migrations/", import.meta.url);
const schemaPath = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
const phaseA = "20261127000000_knowledge_engine_origin_and_claims";
const phaseB = "20261127000100_knowledge_engine_origin_check";
const legacyGuard = "20261127000300_origin_legacy_write_guard";

if (databaseUrl) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, RETAINDB_API_KEY: credential, ENCRYPTION_KEY: credential,
    EMBEDDING_MODE: "remote", EMBEDDING_INFERENCE_BASE_URL: inferenceUrl,
    REMOTE_INFERENCE_REQUIRED: "true", DISABLE_AUTO_EXTRACTION: "false",
    ALERT_EMAIL_ENABLED: "false", OPENAI_API_KEY: "synthetic-provenance-fixture",
  });
}

const claims = {
  entities: [
    { name: "Snapshot", type: "concept", description: "A database snapshot" },
    { name: "Checksum", type: "concept", description: "A verification checksum" },
  ],
  relations: [{ from: "Snapshot", fromType: "concept", to: "Checksum", toType: "concept", relation: "references" }],
};

function offlineInference(t: TestContext) {
  t.mock.method(OpenAI.Chat.Completions.prototype, "create", async () => ({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(claims) } }],
  }));
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    const { inputs } = JSON.parse(String(options?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(() => vector), model });
  });
}

async function fixture(t: TestContext) {
  offlineInference(t);
  const { db } = await import("../src/db/index.js");
  const { api } = await import("../src/api/routes.js");
  const name = `provenance-${randomUUID()}`;
  const project = await db.project.create({ data: { name, slug: name, orgId: "default" } });
  t.after(async () => { await db.project.delete({ where: { id: project.id } }); });
  const headers = { "content-type": "application/json", authorization: `Bearer ${credential}` };
  const post = async (path: string, body: Record<string, unknown>, status = 200) => {
    const response = await api.request(path, { method: "POST", headers, body: JSON.stringify({ project: project.id, ...body }) });
    const text = await response.text();
    assert.equal(response.status, status, text);
    return JSON.parse(text);
  };
  return { db, project, projectId: project.id, post };
}

/** Prisma wraps SQLSTATE in the message; the raw driver exposes it as code. Accept either shape. */
function violation(error: unknown, constraint: string) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  return (code === "23514" || message.includes("23514")) && message.includes(constraint);
}

type EngineFixture = Awaited<ReturnType<typeof fixture>>;

async function storedRow(f: EngineFixture, table: "entities" | "entity_relations", name: string) {
  const [row] = await f.db.$queryRawUnsafe<{ origin: string; isManual: boolean; weight?: number }[]>(
    `SELECT origin, "isManual"${table === "entity_relations" ? ", weight" : ""} FROM ${table} WHERE "projectId" = $1 AND name = $2`,
    f.project.id, name,
  );
  return row;
}

async function learn(f: EngineFixture, content: string) {
  await f.post("/v1/learn", { mode: "text", title: "Restore", content, options: { async: false, strategy_override: "fixed" } });
  for (let attempt = 0; attempt < 25; attempt++) {
    const rows = await f.db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM entities WHERE "projectId" = ${f.project.id}`;
    if (rows[0].count >= 2) return;
    await delay(60);
  }
}

run("manual graph writes carry origin=manual and keep weight as the manual prior", async (t) => {
  const f = await fixture(t);
  await f.post("/v1/entities", { name: "Snapshot", entity_type: "concept", description: "first" }, 201);
  assert.deepEqual(await storedRow(f, "entities", "Snapshot"), { origin: "manual", isManual: true });

  const edge = await f.post("/v1/relations", {
    from_entity: "Snapshot", from_type: "concept", to_entity: "Checksum", to_type: "concept",
    relation_type: "references", weight: 0.6,
  }, 201);
  const [relation] = await f.db.$queryRaw<{ origin: string; isManual: boolean; weight: number }[]>`
    SELECT origin, "isManual", weight FROM entity_relations WHERE id = ${edge.id}`;
  assert.deepEqual(relation, { origin: "manual", isManual: true, weight: 0.6 });

  await f.post("/v1/graph/batch", {
    entities: [{ name: "Ledger", entity_type: "concept" }],
    relations: [{ from_entity: "Ledger", from_type: "concept", to_entity: "Snapshot", to_type: "concept", relation_type: "part_of" }],
  }, 201);
  assert.deepEqual(await storedRow(f, "entities", "Ledger"), { origin: "manual", isManual: true });
  const [batchEdge] = await f.db.$queryRaw<{ origin: string; weight: number }[]>`
    SELECT r.origin, r.weight FROM entity_relations r JOIN entities e ON e.id = r."toEntityId"
    WHERE e.name = 'Snapshot' AND r."relationType" = 'part_of'`;
  assert.deepEqual(batchEdge, { origin: "manual", weight: 1 });
});

run("extraction writes origin=extracted and a later manual edge never promotes the node", async (t) => {
  const f = await fixture(t);
  await learn(f, "Verify the snapshot checksum before restoring database partitions. ".repeat(5));
  assert.deepEqual(await storedRow(f, "entities", "Snapshot"), { origin: "extracted", isManual: false });
  const [extracted] = await f.db.$queryRaw<{ origin: string; isManual: boolean; weight: number }[]>`
    SELECT origin, "isManual", weight FROM entity_relations WHERE "projectId" = ${f.project.id}`;
  assert.deepEqual(extracted, { origin: "extracted", isManual: false, weight: 1 });

  // /v1/relations resolves an existing node instead of silently promoting it to manual.
  await f.post("/v1/relations", {
    from_entity: "Snapshot", from_type: "concept", to_entity: "Ledger", to_type: "concept", relation_type: "related_to",
  }, 201);
  assert.deepEqual(await storedRow(f, "entities", "Snapshot"), { origin: "extracted", isManual: false });
  assert.deepEqual(await storedRow(f, "entities", "Ledger"), { origin: "manual", isManual: true });
});

run("manual edges survive extraction and a manual write promotes an extracted edge", async (t) => {
  const f = await fixture(t);
  await f.post("/v1/relations", {
    from_entity: "Snapshot", from_type: "concept", to_entity: "Checksum", to_type: "concept",
    relation_type: "references", weight: 0.4,
  }, 201);
  await learn(f, "Verify the snapshot checksum before restoring database partitions. ".repeat(5));
  const [kept] = await f.db.$queryRaw<{ origin: string; isManual: boolean; weight: number }[]>`
    SELECT origin, "isManual", weight FROM entity_relations WHERE "projectId" = ${f.project.id}`;
  assert.deepEqual(kept, { origin: "manual", isManual: true, weight: 0.4 });

  const other = await fixture(t);
  await learn(other, "Audit the snapshot checksum before restoring database partitions. ".repeat(5));
  await other.post("/v1/relations", {
    from_entity: "Snapshot", from_type: "concept", to_entity: "Checksum", to_type: "concept",
    relation_type: "references", weight: 0.9,
  }, 201);
  const [promoted] = await other.db.$queryRaw<{ origin: string; isManual: boolean; weight: number }[]>`
    SELECT origin, "isManual", weight FROM entity_relations WHERE "projectId" = ${other.project.id}`;
  assert.deepEqual(promoted, { origin: "manual", isManual: true, weight: 0.9 });
});

run("the origin CHECK ties origin to isManual on both graph tables", async (t) => {
  const f = await fixture(t);
  const insert = (origin: string, isManual: boolean) => f.db.$executeRawUnsafe(
    `INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", origin, "updatedAt")
     VALUES ($1, $2, $3, 'concept', 'concept', $4, $5, NOW())`, randomUUID(), f.projectId, `check-${origin}-${isManual}`, isManual, origin,
  );
  await insert("import", false);
  await assert.rejects(insert("import", true), (error: unknown) => violation(error, "entities_origin_manual_check"));
  await assert.rejects(insert("extracted", true), (error: unknown) => violation(error, "entities_origin_manual_check"));

  // A pod still running the pre-knowledge-engine build omits origin (default 'manual') and writes
  // isManual = false. The guard must keep that write alive and store it as extracted.
  await f.db.$executeRawUnsafe(
    `INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", "updatedAt")
     VALUES ($1, $2, $3, 'concept', 'concept', false, NOW())`, randomUUID(), f.projectId, "legacy-writer",
  );
  assert.deepEqual(await storedRow(f, "entities", "legacy-writer"), { origin: "extracted", isManual: false });
});

async function withDatabase(fn: (client: ReturnType<typeof postgres>) => Promise<void>) {
  const name = `provenance_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const isolated = new URL(databaseUrl!);
  isolated.pathname = `/${name}`;
  let client: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    client = postgres(isolated.toString(), { max: 1, onnotice: () => {} });
    await fn(client);
  } finally {
    await client?.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

run("phase A accepts an old writer, phase B backfills and only then enforces the check", { timeout: 120_000 }, async () => {
  await withDatabase(async (client) => {
    const root = new URL("../prisma/migrations/", import.meta.url);
    const earlier = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name < phaseA).map((entry) => entry.name).sort();
    for (const migration of earlier) await client.unsafe(await readFile(new URL(`${migration}/migration.sql`, root), "utf8")).simple();

    const oldWriter = (id: string, name: string) => client`
      INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", "updatedAt")
      VALUES (${id}, NULL, ${name}, 'concept', 'concept', false, NOW())`;
    await client.unsafe(await readFile(new URL(`${phaseA}/migration.sql`, root), "utf8")).simple();
    await oldWriter("legacy-entity", "Legacy node");
    const initial = await client<{ origin: string }[]>`SELECT origin FROM entities WHERE id = 'legacy-entity'`;
    assert.equal(initial[0].origin, "manual");

    await client.unsafe(await readFile(new URL(`${phaseB}/migration.sql`, root), "utf8")).simple();
    await client.unsafe(await readFile(new URL(`${legacyGuard}/migration.sql`, root), "utf8")).simple();
    const backfilled = await client<{ origin: string }[]>`SELECT origin FROM entities WHERE id = 'legacy-entity'`;
    assert.equal(backfilled[0].origin, "extracted");
    const constraints = await client`SELECT conname, convalidated FROM pg_constraint
      WHERE conname IN ('entities_origin_manual_check', 'entity_relations_origin_manual_check')`;
    assert.deepEqual(constraints.map((row) => [row.conname, row.convalidated]).sort(),
      [["entities_origin_manual_check", true], ["entity_relations_origin_manual_check", true]]);
    await oldWriter("legacy-entity-2", "Another node");
    const guarded = await client<{ origin: string }[]>`SELECT origin FROM entities WHERE id = 'legacy-entity-2'`;
    assert.equal(guarded[0].origin, "extracted");
    await client`INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", origin, "updatedAt")
      VALUES ('extracted-entity', NULL, 'Extracted node', 'concept', 'concept', false, 'extracted', NOW())`;
  });
});
