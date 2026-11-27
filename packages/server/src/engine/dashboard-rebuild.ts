import { createHash, randomUUID } from "node:crypto";
import { prisma, Prisma, type Transaction } from "../db/index.js";
import { embedBatch } from "./embeddings.js";
import { visibleKnowledgeChunks } from "./entity-graph.js";
import { saveChunkGraph, vectorLiteral, type ChunkGraph } from "./entity-graph-write.js";
import { readEntityClaims } from "./extractor.js";
import { EMBEDDING_DIMENSIONS } from "./repo-index/receipt.js";

export type RebuildKind = "graph" | "knowledge";
interface Job { id: string; org_id: string; project_id: string | null; kind: RebuildKind; cursor_id: string; lease_token: string; total: number | null }
interface Chunk {
  id: string; projectId: string; documentId: string; sourceVersionId: string | null;
  content: string; chunkType: string | null;
}
type Prepared = { kind: "knowledge"; model: string; vector: number[] } | { kind: "graph"; claims: ChunkGraph };
interface Staged { chunk_id: string; input_digest: string; payload: Prepared }
const INTERVAL_MS = 2_000;
const KNOWLEDGE_TIMEOUT_MS = 60_000;
const KNOWLEDGE_TIMEOUT_MESSAGE = "Embedding provider timed out. Check the configured provider before retrying.";
class KnowledgeDeadlineExceeded extends Error {}
class RebuildInputChanged extends Error {}
const chunkFields = Prisma.sql`c.id, c."projectId", c."documentId", d."sourceVersionId", c.content, c."chunkType"`;

export function graphRebuildConfigured() {
  return Boolean(process.env.EXTRACTION_MODEL?.trim() && process.env.OPENAI_API_KEY?.trim() && process.env.OPENAI_BASE_URL?.trim());
}

export async function enqueueDashboardRebuild(orgId: string, project: string | undefined, kind: RebuildKind) {
  const [job] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO dashboard_rebuilds (id, org_id, project_id, kind)
    VALUES (${randomUUID()}, ${orgId}, ${project ?? null}, ${kind})
    ON CONFLICT (org_id) WHERE status IN ('queued', 'running') DO NOTHING RETURNING id`;
  return job;
}

async function claimJob() {
  const [job] = await prisma.$queryRaw<Job[]>`
    UPDATE dashboard_rebuilds SET status = 'running', lease_token = ${randomUUID()}, lease_until = now() + interval '5 minutes'
    WHERE id = (SELECT id FROM dashboard_rebuilds WHERE status IN ('queued', 'running')
      AND (lease_until IS NULL OR lease_until <= now()) ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, org_id, project_id, kind, cursor_id, lease_token, total`;
  return job;
}

function eligible(job: Job) {
  // The job row is written by an HTTP round-trip, so a chunk created just before the request can still
  // carry a later timestamp than the job. The window tolerates that skew; anything that genuinely
  // changes while the job runs is still caught by the digest fence in lockCurrentChunk and the
  // countEligible re-check at publish.
  return Prisma.sql`${visibleKnowledgeChunks(job.project_id ?? undefined, job.org_id)}
    AND c."createdAt" <= (SELECT created_at AT TIME ZONE 'UTC' + interval '1 second' FROM dashboard_rebuilds WHERE id = ${job.id})
    ${job.kind === "knowledge" ? Prisma.sql`AND c.embedding IS NULL` : Prisma.empty}`;
}

async function countEligible(db: Pick<Transaction, "$queryRaw">, job: Job) {
  const [row] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count ${eligible(job)}`;
  return row.count;
}

function readBatch(job: Job) {
  return prisma.$queryRaw<Chunk[]>`SELECT ${chunkFields}
    ${eligible(job)} AND c.id > ${job.cursor_id} ORDER BY c.id LIMIT ${job.kind === "graph" ? 1 : 8}`;
}

function inputDigest(chunk: Chunk) {
  const { id, projectId, documentId, sourceVersionId, chunkType, content } = chunk;
  return createHash("sha256").update(JSON.stringify([id, projectId, documentId, sourceVersionId, chunkType, content])).digest("hex");
}

async function lockCurrentChunk(tx: Transaction, job: Job, item: Staged) {
  const [chunk] = await tx.$queryRaw<Chunk[]>`SELECT ${chunkFields} ${eligible(job)} AND c.id = ${item.chunk_id}
    FOR NO KEY UPDATE OF c FOR SHARE OF d, s`;
  if (!chunk || inputDigest(chunk) !== item.input_digest) throw new RebuildInputChanged();
  return chunk;
}

async function embedKnowledgeWithinLease(texts: string[]) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new KnowledgeDeadlineExceeded(KNOWLEDGE_TIMEOUT_MESSAGE);
      reject(error);
      controller.abort(error);
    }, KNOWLEDGE_TIMEOUT_MS);
  });
  try { return await Promise.race([deadline, embedBatch(texts, undefined, controller.signal)]); }
  finally { clearTimeout(timer); }
}

async function prepareKnowledge(chunks: Chunk[]): Promise<Prepared[]> {
  const { vectors, model } = await embedKnowledgeWithinLease(chunks.map(({ content }) => content));
  if (!model || vectors.length !== chunks.length || vectors.some((vector) => !validVector(vector))) {
    throw new Error("Embedding provider returned invalid vectors or did not identify the model.");
  }
  return vectors.map(vector => ({ kind: "knowledge", model, vector }));
}

function validVector(vector: number[]) {
  return vector.length === EMBEDDING_DIMENSIONS && vector.every((n) => Number.isFinite(Math.fround(n))) && vector.some((n) => Math.fround(n) !== 0);
}

async function prepareGraph([chunk]: Chunk[]): Promise<Prepared[]> {
  if (!graphRebuildConfigured()) throw new Error("Graph extraction is not configured.");
  const claims = await readEntityClaims(chunk.content, chunk.chunkType ?? "text", { timeout: 60_000, maxRetries: 0 });
  return [{ kind: "graph", claims }];
}

function claimFilter(job: Job) {
  return Prisma.sql`WHERE id = ${job.id} AND lease_token = ${job.lease_token} AND lease_until > now()`;
}

async function lockJob(tx: Transaction, job: Job) {
  const [row] = await tx.$queryRaw<{ processed: number }[]>`SELECT processed FROM dashboard_rebuilds ${claimFilter(job)} FOR UPDATE`;
  return row;
}

async function stageBatch(job: Job, chunks: Chunk[], total: number) {
  const payloads = await (job.kind === "graph" ? prepareGraph(chunks) : prepareKnowledge(chunks));
  const rows = chunks.map((chunk, index) => Prisma.sql`(${job.id}, ${chunk.id}, ${inputDigest(chunk)}, ${JSON.stringify(payloads[index])}::jsonb)`);
  await prisma.$transaction(async (tx) => {
    if (!await lockJob(tx, job)) return;
    await tx.$executeRaw`INSERT INTO dashboard_rebuild_items (job_id, chunk_id, input_digest, payload) VALUES ${Prisma.join(rows)}`;
    await tx.$executeRaw`UPDATE dashboard_rebuilds SET cursor_id = ${chunks[chunks.length - 1].id},
      processed = processed + ${chunks.length}, total = ${total}, lease_token = NULL, lease_until = NULL WHERE id = ${job.id}`;
  }, { timeout: 10_000 });
}

async function applyPrepared(tx: Transaction, job: Job, item: Staged) {
  const chunk = await lockCurrentChunk(tx, job, item);
  const { payload } = item;
  if (payload.kind !== job.kind) throw new Error("Staged rebuild kind mismatch.");
  if (payload.kind === "graph") return saveChunkGraph(chunk.projectId, chunk.id, payload.claims, "extracted", tx, "merge");
  return tx.$executeRaw`UPDATE chunks SET embedding = ${vectorLiteral(payload.vector)}::vector,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('embedding_model', ${payload.model}::text),
    "updatedAt" = now() WHERE id = ${chunk.id}`;
}

async function applyStaged(tx: Transaction, job: Job) {
  let cursor = "";
  let published = 0;
  for (;;) {
    const items = await tx.$queryRaw<Staged[]>`SELECT chunk_id, input_digest, payload FROM dashboard_rebuild_items
      WHERE job_id = ${job.id} AND chunk_id > ${cursor} ORDER BY chunk_id LIMIT 64`;
    if (!items.length) return published;
    for (const item of items) await applyPrepared(tx, job, item);
    cursor = items[items.length - 1].chunk_id;
    published += items.length;
  }
}

function clearStaged(tx: Transaction, job: Job) {
  return tx.$executeRaw`DELETE FROM dashboard_rebuild_items WHERE job_id = ${job.id}`;
}

async function publishRebuild(job: Job, total: number) {
  await prisma.$transaction(async tx => {
    const locked = await lockJob(tx, job);
    if (!locked) return;
    if (locked.processed !== total || await countEligible(tx, job) !== total) throw new RebuildInputChanged();
    if (await applyStaged(tx, job) !== total) throw new RebuildInputChanged();
    await clearStaged(tx, job);
    await tx.$executeRaw`UPDATE dashboard_rebuilds SET status = 'completed', total = ${total},
      lease_token = NULL, lease_until = NULL WHERE id = ${job.id}`;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
}

async function failRebuild(job: Job, error: string) {
  await prisma.$transaction(async tx => {
    if (!await lockJob(tx, job)) return;
    await clearStaged(tx, job);
    await tx.$executeRaw`UPDATE dashboard_rebuilds SET status = 'failed', error = ${error},
      lease_token = NULL, lease_until = NULL WHERE id = ${job.id}`;
  });
}

export async function runDashboardRebuildBatch() {
  const job = await claimJob();
  if (!job) return;
  try {
    const total = job.total ?? await countEligible(prisma, job);
    const chunks = await readBatch(job);
    if (chunks.length) await stageBatch(job, chunks, total);
    else await publishRebuild(job, total);
  } catch (cause) {
    const error = cause instanceof RebuildInputChanged ? "Indexed content changed during the rebuild. Retry after ingestion settles." :
      job.kind === "graph" ? "Graph extraction or storage failed. Check the configured extraction provider before retrying." :
      cause instanceof KnowledgeDeadlineExceeded ? KNOWLEDGE_TIMEOUT_MESSAGE :
        "Embedding or storage failed. Check the configured embedding provider and model before retrying.";
    await failRebuild(job, error);
  }
}

export function startDashboardRebuildWorker() {
  async function tick() {
    try { await runDashboardRebuildBatch(); }
    catch { console.warn("[dashboard] Rebuild worker could not access its queue."); }
    finally { setTimeout(tick, INTERVAL_MS).unref(); }
  }
  void tick();
}
