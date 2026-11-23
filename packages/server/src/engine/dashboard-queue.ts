import { prisma, Prisma } from "../db/index.js";
import { visibleSourceSql } from "./oracle-visibility.js";

const JOB_LIMIT = 50;
interface JobStatus { kind: string; status: string; count: number }
interface Job { id: string; kind: string; status: string; createdAt: string; processed: number; total: number | null; unit: string; project: string; error?: string }
export interface DashboardQueue { totals: JobStatus[]; jobs: Job[] }

function nativeCaptureJobs(orgId: string) {
  return Prisma.sql`
    SELECT m.id, 'Native capture', m.metadata->>'native_capture_state', m."createdAt" AT TIME ZONE 'UTC',
      (m.metadata->>'native_capture_state' = 'indexed')::int, 1, 'event', false, p.name
    FROM messages m JOIN sessions s ON s.id = m."sessionId"
    JOIN selected_projects p ON p.id = s."projectId"
    WHERE s."orgId" = ${orgId} AND m.metadata->>'source' = 'native_agent_hook'
      AND m.metadata->>'native_capture_state' IN ('pending', 'processing', 'indexed', 'failed')`;
}

function projectJobs(orgId: string) {
  return Prisma.sql`
    SELECT j.id, 'Ingestion' AS kind, j.status, j.created_at AT TIME ZONE 'UTC' AS "createdAt",
      j.processed_documents AS processed, j.total_documents AS total, 'items' AS unit, false AS parts, p.name AS project
    FROM ingestion_jobs j JOIN selected_projects p ON p.id = j.project_id WHERE j.org_id = ${orgId}
    UNION ALL
    SELECT j.id, 'Source sync', j.status, j."createdAt" AT TIME ZONE 'UTC',
      j."documentsIndexed", j."documentsTotal", 'documents', false, p.name
    FROM sync_jobs j JOIN sources s ON s.id = j."sourceId"
    JOIN selected_projects p ON p.id = s."projectId"
    WHERE s."orgId" = ${orgId} AND s."deletedAt" IS NULL ${visibleSourceSql([], orgId)}
    UNION ALL
    SELECT g.id, 'Repository index', CASE
      WHEN g.status NOT IN ('open', 'sealed') THEN g.status
      WHEN scope.state <> 'active' OR g."baseGeneration" > scope."activeGeneration" THEN 'blocked'
      WHEN g."baseGeneration" < scope."activeGeneration" THEN 'superseded'
      ELSE g.status END,
      g."createdAt" AT TIME ZONE 'UTC', 0, g."partCount", 'parts', true, p.name
    FROM repo_index_generations g JOIN repo_index_scopes scope ON scope.id = g."scopeId"
    JOIN selected_projects p ON p.id = scope."projectId"
    WHERE scope."orgId" = ${orgId}
    UNION ALL
    ${nativeCaptureJobs(orgId)}`;
}

function rebuildJobs(projectId: string | undefined, orgId: string) {
  return Prisma.sql`SELECT j.id, CASE j.kind WHEN 'graph' THEN 'Graph rebuild' ELSE 'Knowledge rebuild' END,
    j.status, j.created_at AT TIME ZONE 'UTC', j.processed, j.total, 'chunks', false, COALESCE(p.name, 'All projects')
    FROM dashboard_rebuilds j LEFT JOIN selected_projects p ON p.id = j.project_id
    WHERE j.org_id = ${orgId} AND (p.id IS NOT NULL ${projectId ? Prisma.empty : Prisma.sql`OR j.project_id IS NULL`})`;
}

export async function readDashboardQueue(projectId: string | undefined, orgId: string) {
  const [queue] = await prisma.$queryRaw<DashboardQueue[]>`
    WITH selected_projects AS (
      SELECT id, name FROM projects WHERE "orgId" = ${orgId}
        ${projectId ? Prisma.sql`AND id = ${projectId}` : Prisma.empty}
    ), jobs AS MATERIALIZED (${projectJobs(orgId)} UNION ALL ${rebuildJobs(projectId, orgId)}),
    totals AS (SELECT kind, status, count(*)::int AS count FROM jobs GROUP BY kind, status),
    recent AS (
      SELECT id, kind, status, "createdAt", processed, total, unit, parts, project,
        upper(status) IN ('OPEN', 'SEALED', 'PENDING', 'QUEUED', 'PROCESSING', 'RUNNING') AS active
      FROM jobs ORDER BY active DESC, "createdAt" DESC NULLS LAST, id LIMIT ${JOB_LIMIT}
    ), display AS (
      SELECT id, kind, status, "createdAt", total, unit, active, project, CASE WHEN parts THEN (
        SELECT count(*)::int FROM repo_index_parts WHERE "generationId" = recent.id AND status = 'accepted'
      ) ELSE processed END AS processed,
      (SELECT error FROM dashboard_rebuilds j WHERE j.org_id = ${orgId} AND j.id = recent.id
        AND recent.kind IN ('Graph rebuild', 'Knowledge rebuild')) AS error FROM recent
    )
    SELECT (SELECT COALESCE(jsonb_agg(t ORDER BY kind, status), '[]'::jsonb) FROM totals t) AS totals,
      (SELECT COALESCE(jsonb_agg(CASE WHEN error IS NULL THEN to_jsonb(d) - 'active' - 'error' ELSE to_jsonb(d) - 'active' END
        ORDER BY active DESC, "createdAt" DESC NULLS LAST, id), '[]'::jsonb) FROM display d) AS jobs`;
  return queue;
}
