import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
const run = databaseUrl ? test : test.skip;
const savedEnvironment = { ...process.env };
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.DISABLE_AUTO_EXTRACTION = "true";
  process.env.EMBEDDING_MODE = "local";
}
const ingestPath = "../src/engine/ingest.js";
const projectIds: string[] = [];

function vectors(texts: string[]): number[][] {
  return texts.map((text) => {
    const vector = Array<number>(1024).fill(0);
    vector[0] = 1;
    vector[1] = text.length / 1000;
    return vector;
  });
}

async function fixture() {
  const { db } = await import("../src/db/index.js");
  const { ensureActiveSourceVersion } = await import("../src/engine/source-versions.js");
  const name = `repo-index-${randomUUID()}`;
  const project = await db.project.create({ data: { name, slug: name, orgId: "default" } });
  projectIds.push(project.id);
  const source = await db.source.create({
    data: { projectId: project.id, orgId: "default", name, type: "text", status: "READY" },
  });
  const version = await ensureActiveSourceVersion(source.id);
  assert.ok(version);
  return { db, project, source, version };
}

function input(sourceId: string, projectId: string, versionId: string, embedTexts?: (texts: string[]) => Promise<number[][]>) {
  return {
    sourceId,
    projectId,
    sourceVersionId: versionId,
    externalId: `document-${randomUUID()}.txt`,
    title: "Recovery",
    content: "Verify the PostgreSQL backup checksum before restoring partitions.",
    ingestionProfile: "plain_text" as const,
    strategyOverride: "fixed" as const,
    skipEntityExtraction: true,
    skipSourceCountUpdate: true,
    embedTexts,
  };
}

async function vectorDimensions(db: any, documentId: string): Promise<number[]> {
  const rows = await db.$queryRaw<Array<{ dimensions: number | null }>>`
    SELECT vector_dims(embedding) AS dimensions FROM chunks WHERE "documentId" = ${documentId}
  `;
  return rows.map((row: { dimensions: number | null }) => row.dimensions ?? 0);
}

// Behaviour: an embedder that answers with empty vectors must fail the ingest,
// because an empty array is truthy but carries no searchable content.
run("an empty embedding vector fails the document instead of publishing it", { timeout: 30_000 }, async () => {
  const { ingestDocument } = await import(ingestPath);
  const { db, project, source, version } = await fixture();
  const document = input(source.id, project.id, version.id, async (texts) => texts.map(() => []));

  await assert.rejects(ingestDocument(document), /embedding/i);

  const stored = await db.document.findFirstOrThrow({ where: { externalId: document.externalId } });
  assert.equal(stored.status, "ERROR");
  assert.equal(stored.indexedAt, null);
  assert.equal(await db.chunk.count({ where: { documentId: stored.id } }), 0);
});

// Behaviour: a vector of the wrong width cannot be stored in a vector(1024)
// column, so the ingest must refuse it before it reaches the database.
run("a wrong-dimension embedding vector fails the document", { timeout: 30_000 }, async () => {
  const { ingestDocument } = await import(ingestPath);
  const { db, project, source, version } = await fixture();
  const document = input(source.id, project.id, version.id, async () => [[1, 2, 3]]);

  await assert.rejects(ingestDocument(document), /embedding|dimension|vector/i);

  const stored = await db.document.findFirstOrThrow({ where: { externalId: document.externalId } });
  assert.equal(stored.status, "ERROR");
  assert.equal(await db.chunk.count({ where: { documentId: stored.id } }), 0);
});

// Behaviour: last-good survives. A failed attempt for one document of a source
// must leave the already published document of that source READY with vectors.
run("a failed attempt keeps the already published document searchable", { timeout: 30_000 }, async () => {
  const { ingestDocument } = await import(ingestPath);
  const { db, project, source, version } = await fixture();
  const published = await ingestDocument(input(source.id, project.id, version.id, async (texts) => vectors(texts)));
  assert.equal(published.status, "READY");

  await assert.rejects(
    ingestDocument(input(source.id, project.id, version.id, async (texts) => texts.map(() => []))),
    /embedding/i,
  );

  const stored = await db.document.findUniqueOrThrow({ where: { id: published.documentId } });
  assert.equal(stored.status, "READY");
  const dimensions = await vectorDimensions(db, published.documentId);
  assert.ok(dimensions.length > 0);
  assert.ok(dimensions.every((value) => value === 1024));
});

// Behaviour: the healthy path still stores a 1024-dimension vector for every
// chunk it declares searchable.
run("a successful ingest stores a 1024-dimension vector on every chunk", { timeout: 30_000 }, async () => {
  const { ingestDocument } = await import(ingestPath);
  const { db, project, source, version } = await fixture();

  const result = await ingestDocument(input(source.id, project.id, version.id, async (texts) => vectors(texts)));
  assert.equal(result.status, "READY");

  const dimensions = await vectorDimensions(db, result.documentId);
  assert.ok(dimensions.length > 0);
  assert.ok(dimensions.every((value) => value === 1024));
});

after(async () => {
  if (!databaseUrl) return;
  const { db } = await import("../src/db/index.js");
  if (projectIds.length > 0) await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.$disconnect();
  process.env = savedEnvironment;
});
