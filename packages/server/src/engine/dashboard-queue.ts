import { prisma, Prisma } from "../db/index.js";
import { visibleSourceSql } from "./oracle-visibility.js";

const JOB_LIMIT = 50;
interface JobStatus { kind: string; status: string; count: number }
interface Job { id: string; kind: string; status: string; createdAt: string; processed: number; total: number; unit: string }
export interface DashboardQueue { totals: JobStatus[]; jobs: Job[] }

function nativeCaptureJobs(projectId: string, orgId: string) {
  return Prisma.sql`
    SELECT m.id, 'Native capture', m.metadata->>'native_capture_state', m."createdAt" AT TIME ZONE 'UTC',
      (m.metadata->>'native_capture_state' = 'indexed')::int, 1, 'event', false
    FROM messages m JOIN sessions s ON s.id = m."sessionId"
    WHERE s."projectId" = ${projectId} AND s."orgId" = ${orgId} AND m.metadata->>'source' = 'native_agent_hook'
      AND m.metadata->>'native_capture_state' IN ('pending', 'processing', 'indexed', 'failed')`;
}

function projectJobs(projectId: string, orgId: string) {
  return Prisma.sql`
    SELECT id, 'Ingestion' AS kind, status, created_at AT TIME ZONE 'UTC' AS "createdAt",
      processed_documents AS processed, total_documents AS total, 'items' AS unit, false AS parts
    FROM ingestion_jobs WHERE project_id = ${projectId} AND org_id = ${orgId}
    UNION ALL
    SELECT j.id, 'Source sync', j.status, j."createdAt" AT TIME ZONE 'UTC',
      j."documentsIndexed", j."documentsTotal", 'documents', false
    FROM sync_jobs j JOIN sources s ON s.id = j."sourceId"
    WHERE s."projectId" = ${projectId} AND s."orgId" = ${orgId} AND s."deletedAt" IS NULL ${visibleSourceSql([], orgId)}
    UNION ALL
    SELECT g.id, 'Repository index', CASE
      WHEN g.status NOT IN ('open', 'sealed') THEN g.status
      WHEN scope.state <> 'active' OR g."baseGeneration" > scope."activeGeneration" THEN 'blocked'
      WHEN g."baseGeneration" < scope."activeGeneration" THEN 'superseded'
      ELSE g.status END,
      g."createdAt" AT TIME ZONE 'UTC', 0, g."partCount", 'parts', true
    FROM repo_index_generations g JOIN repo_index_scopes scope ON scope.id = g."scopeId"
    WHERE scope."projectId" = ${projectId} AND scope."orgId" = ${orgId}
    UNION ALL
    ${nativeCaptureJobs(projectId, orgId)}`;
}

export async function readDashboardQueue(projectId: string, orgId: string) {
  const [queue] = await prisma.$queryRaw<DashboardQueue[]>`
    WITH jobs AS MATERIALIZED (${projectJobs(projectId, orgId)}),
    totals AS (SELECT kind, status, count(*)::int AS count FROM jobs GROUP BY kind, status),
    recent AS (
      SELECT id, kind, status, "createdAt", processed, total, unit, parts,
        upper(status) IN ('OPEN', 'SEALED', 'PENDING', 'QUEUED', 'PROCESSING', 'RUNNING') AS active
      FROM jobs ORDER BY active DESC, "createdAt" DESC NULLS LAST, id LIMIT ${JOB_LIMIT}
    ), display AS (
      SELECT id, kind, status, "createdAt", total, unit, active, CASE WHEN parts THEN (
        SELECT count(*)::int FROM repo_index_parts WHERE "generationId" = recent.id AND status = 'accepted'
      ) ELSE processed END AS processed FROM recent
    )
    SELECT (SELECT COALESCE(jsonb_agg(t ORDER BY kind, status), '[]'::jsonb) FROM totals t) AS totals,
      (SELECT COALESCE(jsonb_agg(to_jsonb(d) - 'active' ORDER BY active DESC, "createdAt" DESC NULLS LAST, id), '[]'::jsonb) FROM display d) AS jobs`;
  return queue;
}
