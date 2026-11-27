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
  const name = `ingest-${randomUUID()}`;
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

run("a required embedding failure records ERROR and leaves no chunks", { timeout: 30_000 }, async () => {
  const { ingestDocument } = await import(ingestPath);
  const { db, project, source, version } = await fixture();
  const document = input(source.id, project.id, version.id, async () => {
    throw new Error("embedding unavailable");
  });

  await assert.rejects(ingestDocument(document), /embedding unavailable/);

  const stored = await db.document.findFirstOrThrow({ where: { externalId: document.externalId } });
  assert.equal(stored.status, "ERROR");
  assert.equal(stored.indexedAt, null);
  assert.match(stored.parseError ?? "", /embedding unavailable/);
  assert.equal(await db.chunk.count({ where: { documentId: stored.id } }), 0);
  await assert.rejects(
    ingestDocument({ ...document, externalId: `second-${randomUUID()}.txt` }),
    /embedding unavailable/,
  );
  await db.source.update({ where: { id: source.id }, data: { status: "READY" } });
  await assert.rejects(ingestDocument({ ...document, externalId: `third-${randomUUID()}.txt`, skipSourceCountUpdate: false }), /embedding unavailable/);
  const failedSource = await db.source.findUniqueOrThrow({ where: { id: source.id } });
  assert.equal(failedSource.status, "ERROR");
});

// Two paragraphs, each too long to share one 700-character child chunk and together short
// enough for one parent group, so a hierarchical ingest emits parent context plus children.
const PARENT_CONTEXT_CONTENT = `${[
  "Before restoring a partition, verify the PostgreSQL backup checksum and stop writes to the database. A restore that overlaps live traffic hides the rows it failed to write, and the failure only surfaces when a reader asks for a record the new table never received. Record which partition each backup covers, how many rows it holds, and the point in time it represents, so the restored table can be compared against the source once the restore reports success. Keep the checksum with the backup, because a backup that was truncated in transit restores without an error and leaves the table short.",
  "Compare row counts and the newest timestamp in every restored partition before releasing writes. A table that reports the expected count can still hold rows from the wrong backup if the restore read the previous dump, so compare the identifier range as well. When a partition holds more rows than the backup recorded, stop and inspect the table instead of deleting the extra rows, because an overlap usually means the backup was taken while a writer was still running. Only then release the source and re-enable the writes.",
].join("\n\n")}`;

// A chunk that is not searchable (parent context) is stored with no vector at all, because no
// similarity query could ever match it, while its children carry the vectors that make the text
// findable. The assertion reads the stored rows, not the chunk plan: the NULL binding lives in the
// INSERT, so only a database read proves it.
run("a hierarchical document stores parent context without a vector", { timeout: 30_000 }, async () => {
  const { ingestDocument } = await import(ingestPath);
  const { db, project, source, version } = await fixture();
  // The repo profile selects the hierarchical strategy itself (ingestion-profiles.ts), so this is
  // the production path a connector takes, not a strategy the test picks by hand.
  const document = {
    ...input(source.id, project.id, version.id, async (texts) => vectors(texts)),
    content: PARENT_CONTEXT_CONTENT,
    ingestionProfile: "repo" as const,
    strategyOverride: undefined,
  };

  const result = await ingestDocument(document);
  assert.equal(result.status, "READY");

  const rows = await db.$queryRaw<
    Array<{ id: string; parentChunkId: string | null; vectorIsNull: boolean; dimensions: number | null; contentKind: string | null }>
  >`
    SELECT id, "parentChunkId", embedding IS NULL AS "vectorIsNull", vector_dims(embedding) AS dimensions,
           metadata->>'content_kind' AS "contentKind"
    FROM chunks WHERE "documentId" = ${result.documentId}
  `;

  const parents = rows.filter((row) => row.vectorIsNull);
  assert.equal(parents.length, 1, "the hierarchy stored exactly one parent-context chunk");
  const [parent] = parents;
  assert.equal(parent.contentKind, "parent_context");
  assert.equal(parent.dimensions, null, "a parent row carries no vector dimensions");
  assert.equal(parent.parentChunkId, null);

  const children = rows.filter((row) => row.parentChunkId === parent.id);
  assert.ok(children.length >= 2, `the parent groups at least two children, saw ${children.length}`);
  assert.equal(children.length, rows.length - 1, "every other chunk of the document is a child of the parent");
  assert.ok(children.every((child) => !child.vectorIsNull), "every child carries a stored vector");
  assert.ok(
    children.every((child) => child.dimensions === 1024),
    `every child vector is 1024 dimensions, saw ${children.map((child) => child.dimensions).join(",")}`,
  );

  assert.equal(result.chunksCreated, rows.length);
  assert.equal(result.searchableChunksCreated, children.length, "the parent is not reported as a searchable chunk");
  assert.equal(rows.filter((row) => !row.vectorIsNull).length, result.searchableChunksCreated);
});

run("a successful ingest publishes READY with vectors for every chunk", { timeout: 30_000 }, async () => {
  const { ingestDocument } = await import(ingestPath);
  const { db, project, source, version } = await fixture();
  const document = input(source.id, project.id, version.id, async (texts) => vectors(texts));

  const result = await ingestDocument({ ...document, skipSourceCountUpdate: false });
  assert.equal(result.status, "READY");

  const chunks = await db.$queryRaw<Array<{ dimensions: number }>>`
    SELECT vector_dims(embedding) AS dimensions FROM chunks WHERE "documentId" = ${result.documentId}
  `;
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((chunk) => chunk.dimensions === 1024));
  const healthySource = await db.source.findUniqueOrThrow({ where: { id: source.id } });
  assert.equal(healthySource.status, "READY");
});

run("a failed batch settles owned work before rejecting", { timeout: 30_000 }, async () => {
  const { ingestDocuments } = await import(ingestPath);
  const { db, project, source, version } = await fixture();
  const documents = Array.from({ length: 5 }, () => input(source.id, project.id, version.id, async () => {
    throw new Error("batch embedding unavailable");
  }));

  await assert.rejects(ingestDocuments(documents), /batch embedding unavailable/);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const stored = await db.document.findMany({ where: { sourceId: source.id } });
  assert.equal(stored.length, documents.length);
  assert.ok(stored.every((document) => document.status === "ERROR"));
  assert.equal(await db.chunk.count({ where: { document: { sourceId: source.id } } }), 0);
});

after(async () => {
  if (!databaseUrl) return;
  const { db } = await import("../src/db/index.js");
  if (projectIds.length > 0) await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.$disconnect();
  process.env = savedEnvironment;
});
