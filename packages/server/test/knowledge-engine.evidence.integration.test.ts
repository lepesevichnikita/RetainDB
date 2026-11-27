import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const vector = [1, ...Array<number>(1023).fill(0)];
const inferenceUrl = "https://evidence-fixture.invalid";
const credential = randomUUID();

if (databaseUrl) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl, RETAINDB_API_KEY: credential, ENCRYPTION_KEY: credential,
    EMBEDDING_MODE: "remote", EMBEDDING_INFERENCE_BASE_URL: inferenceUrl,
    REMOTE_INFERENCE_REQUIRED: "true", DISABLE_AUTO_EXTRACTION: "true",
    ALERT_EMAIL_ENABLED: "false", OPENAI_API_KEY: "synthetic-evidence-fixture",
  });
}

const graph = {
  entities: [
    { name: "Snapshot", entityType: "concept", description: "A database snapshot" },
    { name: "Checksum", entityType: "concept", description: "A verification checksum" },
  ],
  relations: [{ from: { name: "Snapshot", entityType: "concept" }, to: { name: "Checksum", entityType: "concept" }, type: "references" as const }],
};

function offlineInference(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), `${inferenceUrl}/v1/inference/embeddings`);
    const { inputs } = JSON.parse(String(options?.body)) as { inputs: string[] };
    return Response.json({ embeddings: inputs.map(() => vector), model: "evidence-fixture-model" });
  });
}

async function fixture(t: TestContext) {
  offlineInference(t);
  const { db } = await import("../src/db/index.js");
  const { api } = await import("../src/api/routes.js");
  const name = `evidence-${randomUUID()}`;
  const project = await db.project.create({ data: { name, slug: name, orgId: "default" } });
  t.after(async () => { await db.project.delete({ where: { id: project.id } }); });
  const source = await db.source.create({ data: { projectId: project.id, name: `${name}-source`, type: "text", status: "READY" } });
  const headers = { "content-type": "application/json", authorization: `Bearer ${credential}` };
  const query = (includeEvidence: boolean) => api.request("/v1/context/query", {
    method: "POST", headers,
    body: JSON.stringify({ project: project.id, query: "snapshot checksum", include_graph: true, include_evidence: includeEvidence, hybrid: false, use_vector: false, rerank: false }),
  });
  return { db, project, source, query };
}

type EvidenceFixture = Awaited<ReturnType<typeof fixture>>;

async function importDocuments(f: EvidenceFixture, contents = [1, 2, 3, 4].map((index) => `Snapshot checksum guide number ${index}. `.repeat(8))) {
  const { importSourceVersion } = await import("../src/engine/knowledge/import.js");
  const documents = contents.map((content, position) => ({
    externalId: `restore-${position + 1}.md`, title: `Restore ${position + 1}`,
    content, path: `docs/restore-${position + 1}.md`, url: `https://example.test/restore-${position + 1}`, graph,
  }));
  await importSourceVersion({ sourceId: f.source.id, projectId: f.project.id, documents });
}

function relationsOf(body: { results: { metadata?: { graph?: { relations?: { id: string; claims?: unknown[] }[] } } }[] }) {
  return body.results.flatMap((hit) => hit.metadata?.graph?.relations ?? []);
}

run("include_evidence attaches the top three openable claims to each relation", async (t) => {
  const f = await fixture(t);
  await importDocuments(f);
  const response = await f.query(true);
  assert.equal(response.status, 200);
  const body = await response.json() as Parameters<typeof relationsOf>[0];
  const relations = relationsOf(body);
  assert.equal(relations.length >= 1, true);
  const claims = (relations[0].claims ?? []) as {
    snippet: string; sourceId: string; documentExternalId: string | null;
    path: string | null; url: string | null; contentDigest: string; confidence: number; origin: string;
  }[];
  // Four documents asserted the same relation; the cap keeps three, best confidence first.
  assert.equal(claims.length, 3);
  assert.deepEqual(claims.map(({ confidence }) => confidence), [0.8, 0.8, 0.8]);
  for (const claim of claims) {
    assert.equal(claim.snippet.startsWith("Snapshot checksum guide number"), true);
    assert.equal(claim.sourceId, f.source.id);
    assert.equal(claim.path?.startsWith("docs/restore-"), true);
    assert.equal(claim.url?.startsWith("https://example.test/restore-"), true);
    assert.equal(claim.contentDigest.length, 64);
    assert.equal(claim.origin, "import");
    assert.equal(claim.documentExternalId?.startsWith("restore-"), true);
  }
  assert.equal(new Set(claims.map(({ path }) => path)).size, 3);

  // Without the flag the answer carries no claim payload at all.
  const plain = await f.query(false);
  assert.equal(plain.status, 200);
  assert.equal((await plain.text()).includes("\"claims\""), false);

  // A new version with other content deactivates the imported claims: only active evidence is served.
  await importDocuments(f, ["Rewritten checksum guide for the new restore. ".repeat(8)]);
  const current = relationsOf(await (await f.query(true)).json() as Parameters<typeof relationsOf>[0])[0];
  const active = (current.claims ?? []) as { snippet: string }[];
  assert.equal(active.length, 1);
  assert.equal(active[0].snippet.startsWith("Rewritten checksum guide"), true);
});

run("relation evidence answers for every relation in a single query", async (t) => {
  const f = await fixture(t);
  await importDocuments(f);
  const { relationEvidence, saveClaims } = await import("../src/engine/knowledge/claims.js");
  const [evidence] = await f.db.evidence.findMany({ where: { source: { projectId: f.project.id } } });
  const [origin] = await f.db.entity.findMany({ where: { projectId: f.project.id }, orderBy: { name: "asc" } });
  const targets = Array.from({ length: 40 }, () => randomUUID());
  await f.db.entity.createMany({ data: targets.map((id, index) => ({
    id, projectId: f.project.id, name: `Target ${index}`, type: "concept", entityType: "concept", isManual: false, origin: "import" as const,
  })) });
  const relations = targets.map(() => randomUUID());
  await f.db.entityRelation.createMany({ data: relations.map((id, index) => ({
    id, projectId: f.project.id, fromEntityId: origin.id, toEntityId: targets[index], relationType: "references",
    isManual: false, origin: "import" as const,
  })) });
  await saveClaims(f.db, relations.map((relationId) => ({
    target: { kind: "relation" as const, relationId },
    evidence: { sourceId: f.source.id, contentDigest: evidence.contentDigest, text: evidence.text },
    confidence: 0.8, origin: "import" as const,
  })));

  // Count the round trips the answer actually costs: 40 relations must not become 40 queries.
  const calls = { count: 0 };
  const counted = {
    $queryRaw: (...args: Parameters<typeof f.db.$queryRaw>) => {
      calls.count += 1;
      return f.db.$queryRaw(...args);
    },
  };
  const found = await relationEvidence(f.project.id, relations, 3, counted as unknown as Parameters<typeof relationEvidence>[3]);
  assert.equal(calls.count, 1);
  assert.equal([...found.values()].filter((rows) => rows.length > 0).length, 40);
});

run("include_evidence stays inside a bounded latency budget", async (t) => {
  const f = await fixture(t);
  await importDocuments(f);
  const p95 = async (includeEvidence: boolean) => {
    const timings: number[] = [];
    for (let index = 0; index < 25; index++) {
      const started = performance.now();
      const response = await f.query(includeEvidence);
      assert.equal(response.status, 200);
      await response.text();
      timings.push(performance.now() - started);
    }
    return timings.sort((left, right) => left - right)[Math.floor(timings.length * 0.95)] ?? 0;
  };
  await p95(false); // warm the pool and the query plans before measuring
  const without = await p95(false);
  const withEvidence = await p95(true);
  t.diagnostic(`context-query p95: ${without.toFixed(1)}ms without evidence, ${withEvidence.toFixed(1)}ms with`);
  // Absolute bound, not a ratio: a wall-clock ratio on a shared machine flakes. The delta is reported above.
  assert.equal(withEvidence - without < 50, true, `p95 without=${without.toFixed(1)}ms with=${withEvidence.toFixed(1)}ms`);
});
