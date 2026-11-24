import { prisma, Prisma } from "../db/index.js";
import { browseProjectGraph, countVisibleGraphEntities, recentVisibleKnowledgeChunks, visibleKnowledgeStatistics } from "./entity-graph.js";
import { readDashboardQueue } from "./dashboard-queue.js";

export const OSS_ORG = "default";
const VECTOR_POINTS = 200;
const STATISTICS_REFRESH_MS = 5 * 60_000;
const embeddingModel = Prisma.sql`NULLIF(c.metadata->>'embedding_model', '')`;
type Reader = Pick<Prisma.TransactionClient, "$queryRaw">;
type View = "overview" | "graph" | "vectors" | "queue";
interface Input { project?: string; q?: string; model?: string }
interface VectorModel { model: string | null; count: number }
interface PlottableModel { model: string; count: number | null }
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
    SELECT m.model, sum(m.count)::int AS count
    FROM (SELECT c.models ${visibleKnowledgeStatistics(projectId, orgId)}) visible
    CROSS JOIN LATERAL jsonb_to_recordset(visible.models) AS m(model text, count integer)
    GROUP BY m.model ORDER BY count DESC, m.model ASC NULLS LAST`;
}

async function knowledgeCounts(db: Reader, projectId: string | undefined, orgId: string) {
  const [counts] = await db.$queryRaw<KnowledgeCounts[]>`
    SELECT count(*)::int AS documents, coalesce(sum(c.chunks), 0)::int AS chunks,
      count(DISTINCT s.id)::int AS sources, coalesce(sum(c.embedded), 0)::int AS embedded
    ${visibleKnowledgeStatistics(projectId, orgId)}`;
  return counts;
}

async function countsAsOf(db: Reader) {
  const [row] = await db.$queryRaw<{ countsAsOf: Date }[]>`
    SELECT counts_as_of AS "countsAsOf" FROM dashboard_statistics_refresh WHERE singleton`;
  return row.countsAsOf.toISOString();
}

function readOverview(projectId: string | undefined, orgId: string) {
  return prisma.$transaction(async (db) => {
    const counts = await knowledgeCounts(db, projectId, orgId);
    const memories = await db.memory.count({ where: { orgId, isActive: true, project: { id: projectId, orgId } } });
    const entities = await countVisibleGraphEntities(db, projectId, orgId);
    const models = await vectorModels(db, projectId, orgId);
    return { ...counts, memories, entities, models, countsAsOf: await countsAsOf(db) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

const modelFilter = (model: string) => Prisma.sql`AND md5(${embeddingModel}) = md5(${model}::text) AND ${embeddingModel} = ${model}`;

async function liveVectorModel(db: Reader, projectId: string | undefined, orgId: string, model?: string) {
  const filter = model ? modelFilter(model) : Prisma.sql`AND ${embeddingModel} IS NOT NULL AND vector_norm(c.embedding) > 0`;
  const [row] = await db.$queryRaw<{ model: string }[]>`
    SELECT ${embeddingModel} AS model ${recentVisibleKnowledgeChunks(projectId, orgId)}
    AND c.embedding IS NOT NULL ${filter} ORDER BY c."createdAt" DESC, c.id LIMIT 1`;
  return row?.model ?? null;
}

/** Keep raw embeddings in Postgres; each coordinate is cosine similarity to a real stored vector. */
function vectorPoints(db: Reader, projectId: string | undefined, orgId: string, model: string) {
  return db.$queryRaw<VectorPoint[]>`
    WITH sample AS MATERIALIZED (
      SELECT c.id, c."createdAt", left(d.title, 240) AS label, c."chunkIndex", c."chunkType" AS type, c.embedding,
        (SELECT project.name FROM projects project WHERE project.id = c."projectId") AS project
      ${recentVisibleKnowledgeChunks(projectId, orgId)} AND c.embedding IS NOT NULL ${modelFilter(model)}
      AND vector_norm(c.embedding) > 0
      ORDER BY c."createdAt" DESC, c.id LIMIT ${VECTOR_POINTS}
    ), a AS (SELECT * FROM sample ORDER BY "createdAt" DESC, id LIMIT 1),
    b AS (SELECT sample.* FROM sample CROSS JOIN a
      ORDER BY sample.embedding <=> a.embedding DESC, sample."createdAt" DESC, sample.id LIMIT 1)
    SELECT p.id, p.label, p."chunkIndex", p.type, p.project, 1 - (p.embedding <=> a.embedding) AS x, 1 - (p.embedding <=> b.embedding) AS y
    FROM sample p CROSS JOIN a CROSS JOIN b ORDER BY p."createdAt" DESC, p.id`;
}

async function selectVectorSample(db: Reader, projectId: string | undefined, orgId: string, preferred?: string, fallback = true) {
  const sample = (model: string) => vectorPoints(db, projectId, orgId, model);
  const points = preferred ? await sample(preferred) : [];
  if (preferred && points.length) return { model: preferred, points };
  const recent = fallback ? await liveVectorModel(db, projectId, orgId) : null;
  if (recent) return { model: recent, points: await sample(recent) };
  return { model: preferred ? await liveVectorModel(db, projectId, orgId, preferred) : null, points };
}

function readVectors(projectId: string | undefined, orgId: string, requestedModel?: string) {
  return prisma.$transaction(async (db) => {
    const models: PlottableModel[] = (await vectorModels(db, projectId, orgId)).filter((row): row is { model: string; count: number } => row.model !== null);
    const { model, points } = await selectVectorSample(db, projectId, orgId, requestedModel ?? models[0]?.model, !requestedModel);
    if (requestedModel && !model) return null;
    if (model && !models.some((item) => item.model === model)) models.unshift({ model, count: null });
    return { models, model, points, countsAsOf: await countsAsOf(db),
      anchors: points.length ? [points[0].label, points.reduce((far, point) => point.x < far.x ? point : far).label] : [], limit: VECTOR_POINTS };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function refreshDashboardStatistics() {
  return prisma.$transaction(async (db) => {
    const [lock] = await db.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(194846250, 1) AS acquired`;
    if (!lock.acquired) return;
    await db.$executeRaw`SET LOCAL statement_timeout = '4min'`;
    await db.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_chunk_statistics`;
    await db.$executeRaw`UPDATE dashboard_statistics_refresh SET counts_as_of = transaction_timestamp() WHERE singleton`;
  }, { timeout: 250_000 });
}

export function startDashboardStatisticsRefresh() {
  async function tick() {
    try { await refreshDashboardStatistics(); }
    catch { console.warn("[dashboard] Statistics refresh failed; serving the last successful counts."); }
    finally { setTimeout(tick, STATISTICS_REFRESH_MS).unref(); }
  }
  setTimeout(tick, STATISTICS_REFRESH_MS).unref();
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
