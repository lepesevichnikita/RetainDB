import { prisma, Prisma } from "../db/index.js";
import { browseProjectGraph, countVisibleGraphEntities, visibleKnowledgeChunks } from "./entity-graph.js";
import { readDashboardQueue } from "./dashboard-queue.js";

export const OSS_ORG = "default";
const VECTOR_POINTS = 200;
const embeddingModel = Prisma.sql`NULLIF(c.metadata->>'embedding_model', '')`;
type Reader = Pick<Prisma.TransactionClient, "$queryRaw">;
type View = "overview" | "graph" | "vectors" | "queue";
interface Input { project?: string; q?: string; model?: string }
interface VectorModel { model: string | null; count: number }
interface KnowledgeCounts { documents: number; chunks: number; sources: number; embedded: number }
interface VectorPoint { id: string; label: string; chunkIndex: number; type: string | null; project: string; x: number; y: number }

export function dashboardProjects() {
  return prisma.project.findMany({
    where: { orgId: OSS_ORG }, orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, slug: true },
  });
}

export function dashboardProject(id: string) {
  return prisma.project.findFirst({ where: { id, orgId: OSS_ORG }, select: { orgId: true } });
}

function vectorModels(db: Reader, projectId: string | undefined, orgId: string) {
  return db.$queryRaw<VectorModel[]>`
    SELECT ${embeddingModel} AS model, count(*)::int AS count
    ${visibleKnowledgeChunks(projectId, orgId)} AND c.embedding IS NOT NULL
    GROUP BY model ORDER BY count DESC, model ASC NULLS LAST`;
}

async function knowledgeCounts(db: Reader, projectId: string | undefined, orgId: string) {
  const [counts] = await db.$queryRaw<KnowledgeCounts[]>`
    SELECT count(DISTINCT d.id)::int AS documents, count(*)::int AS chunks,
      count(DISTINCT s.id)::int AS sources, count(c.embedding)::int AS embedded
    ${visibleKnowledgeChunks(projectId, orgId)}`;
  return counts;
}

function readOverview(projectId: string | undefined, orgId: string) {
  return prisma.$transaction(async (db) => {
    const counts = await knowledgeCounts(db, projectId, orgId);
    const memories = await db.memory.count({ where: { orgId, isActive: true, project: { id: projectId, orgId } } });
    const entities = await countVisibleGraphEntities(db, projectId, orgId);
    const models = await vectorModels(db, projectId, orgId);
    return { ...counts, memories, entities, models };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Keep raw embeddings in Postgres; each coordinate is cosine similarity to a real stored vector. */
function vectorPoints(db: Reader, projectId: string | undefined, orgId: string, model: string) {
  return db.$queryRaw<VectorPoint[]>`
    WITH sample AS MATERIALIZED (
      SELECT c.id, c."createdAt", left(d.title, 240) AS label, c."chunkIndex", c."chunkType" AS type, c.embedding,
        (SELECT project.name FROM projects project WHERE project.id = c."projectId") AS project
      ${visibleKnowledgeChunks(projectId, orgId)} AND c.embedding IS NOT NULL AND ${embeddingModel} = ${model}
        AND vector_norm(c.embedding) > 0
      ORDER BY c."createdAt" DESC, c.id LIMIT ${VECTOR_POINTS}
    ), a AS (SELECT * FROM sample ORDER BY "createdAt" DESC, id LIMIT 1),
    b AS (SELECT sample.* FROM sample CROSS JOIN a
      ORDER BY sample.embedding <=> a.embedding DESC, sample."createdAt" DESC, sample.id LIMIT 1)
    SELECT p.id, p.label, p."chunkIndex", p.type, p.project, 1 - (p.embedding <=> a.embedding) AS x, 1 - (p.embedding <=> b.embedding) AS y
    FROM sample p CROSS JOIN a CROSS JOIN b ORDER BY p."createdAt" DESC, p.id`;
}

function readVectors(projectId: string | undefined, orgId: string, requestedModel?: string) {
  return prisma.$transaction(async (db) => {
    const models = (await vectorModels(db, projectId, orgId)).filter(({ model }) => model !== null);
    if (requestedModel && !models.some(({ model }) => model === requestedModel)) return null;
    const model = requestedModel ?? models[0]?.model ?? null;
    const points = model ? await vectorPoints(db, projectId, orgId, model) : [];
    return { models, model, points, anchors: points.length ? [points[0].label, points.reduce((far, point) => point.x < far.x ? point : far).label] : [], limit: VECTOR_POINTS };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function readDashboardView(view: View, { project, q, model }: Input) {
  const orgId = OSS_ORG;
  switch (view) {
    case "overview": return readOverview(project, orgId);
    case "graph": return browseProjectGraph(project, orgId, q?.trim() ?? "");
    case "vectors": return readVectors(project, orgId, model);
    case "queue": return readDashboardQueue(project, orgId);
  }
}
