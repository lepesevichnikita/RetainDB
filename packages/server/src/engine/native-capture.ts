import { createHash } from "node:crypto";
import { prisma, type Transaction } from "../db/index.js";
import { hashIdempotencyPayload } from "../api/idempotency.js";
import { ingestDocument } from "./ingest.js";
import { embedNativeCapture, stopNativeEmbeddingProcess } from "./native-embeddings.js";
import { redactCapture } from "../../../local/plugin/scripts/_redact.mjs";

export { redactCapture };

function stableId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const MAX_CAPTURE_ATTEMPTS = Number(process.env.NATIVE_CAPTURE_MAX_ATTEMPTS ?? 8);

export function captureRetryPlan(attempts: number): { state: "pending" | "failed"; retryAfterSeconds: number | null } {
  if (attempts >= MAX_CAPTURE_ATTEMPTS) return { state: "failed", retryAfterSeconds: null };
  return { state: "pending", retryAfterSeconds: Math.min(300, 2 ** Math.min(8, attempts)) };
}

export interface NativeCaptureInput {
  orgId: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  hookType: string;
  data: Record<string, unknown>;
  machine?: string;
  timestamp?: string;
  workstation?: { text: string; model: string; vector: number[] };
}

export async function acceptNativeCapture(input: NativeCaptureInput) {
  const { orgId, projectId, sessionId, agentId, hookType } = input;
  const digest = hashIdempotencyPayload(input);
  const id = stableId(`native-event:${digest}`);
  const sessionKey = stableId(JSON.stringify([orgId, projectId, sessionId]));
  const safeData = redactCapture(input.data) as Record<string, unknown>;
  const content = input.workstation?.text ?? `${hookType}\n${JSON.stringify(safeData)}`;
  const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
  const message = await prisma.$transaction(async tx => {
    await tx.session.upsert({
      where: { id: sessionKey },
      create: { id: sessionKey, orgId, projectId, sessionId, agentId, title: `Agent session ${sessionId}` },
      update: { sessionId },
    });
    const existing = await tx.message.findUnique({ where: { id } });
    if (existing) return existing;
    const stored = await tx.message.create({
      data: {
        id, sessionId: sessionKey, role: "event", content, createdAt: timestamp,
        metadata: {
          source: "native_agent_hook", external_session_id: sessionId, agent_id: agentId,
          ...(input.machine ? { tags: [`machine:${input.machine}`] } : {}),
          hook_type: hookType, data: safeData as object, native_capture_state: "pending", capture_attempts: 0,
        },
      },
    });
    await tx.session.update({
      where: { id: sessionKey },
      data: { messageCount: { increment: 1 }, lastMessageAt: timestamp },
    });
    if (input.workstation) return indexWorkstationReceipt(tx, input, stored);
    return stored;
  });
  if (!input.workstation) void drainNativeCaptures().catch(error => console.error("[NativeCapture] Drain failed:", error));
  return { id: message.id, status: (message.metadata as Record<string, unknown>).native_capture_state };
}

interface PendingCapture {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  projectId: string;
  orgId: string;
  externalSessionId: string;
}

async function indexWorkstationReceipt(tx: Transaction, input: NativeCaptureInput, stored: { id: string; content: string; metadata: unknown }) {
  const metadata = stored.metadata as Record<string, unknown>;
  const documentId = await indexCapture({ ...stored, metadata, projectId: input.projectId, orgId: input.orgId, externalSessionId: input.sessionId }, tx, input.workstation);
  return tx.message.update({ where: { id: stored.id }, data: { metadata: { ...metadata,
    native_capture_state: "indexed", document_id: documentId, indexed_at: new Date().toISOString(), capture_attempts: 1,
  } } });
}

async function indexCapture(message: PendingCapture, db: Transaction, embedding?: NativeCaptureInput["workstation"]): Promise<string> {
  const deadline = Date.now() + 120_000;
  const sourceName = `native-agent-hooks-${message.projectId}`;
  const source = await db.source.upsert({
    where: { projectId_name: { projectId: message.projectId, name: sourceName } },
    create: {
      orgId: message.orgId, projectId: message.projectId, name: sourceName,
      type: "text", connectorType: "native_agent_hook", config: {}, status: "INDEXING",
    },
    update: {},
  });
  const document = await ingestDocument({
    sourceId: source.id, projectId: message.projectId, externalId: message.id,
    title: `${message.metadata.hook_type} (${message.externalSessionId})`, content: message.content,
    ingestionProfile: "plain_text", strategyOverride: "fixed", skipEntityExtraction: true,
    embedTexts: texts => embedding === undefined ? embedNativeCapture(texts, deadline - Date.now()) : suppliedCaptureEmbedding(message.content, texts, embedding),
    metadata: {
      ...message.metadata, native_capture_state: undefined,
      event_id: message.id, session_id: message.externalSessionId, source: "native_agent_hook",
    },
  }, db);
  const [{ total, vectors }] = await db.$queryRaw<Array<{ total: number; vectors: number }>>`
    SELECT COUNT(*)::int AS total, COUNT(embedding)::int AS vectors
    FROM chunks WHERE "documentId" = ${document.id} AND COALESCE(metadata->>'searchable', 'true') != 'false'
  `;
  if (!total || total !== vectors || total !== document.chunkStats.searchableChunks) {
    throw new Error("Native capture requires vectors for every searchable chunk");
  }
  return document.id;
}

async function suppliedCaptureEmbedding(content: string, texts: string[], embedding: { model: string; vector: number[] }) {
  if (texts.length !== 1 || texts[0] !== content) throw new Error("Workstation capture vector must cover exactly one unchanged searchable chunk");
  return { vectors: [embedding.vector], model: embedding.model };
}

async function processNextCapture(): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<PendingCapture[]>`
      SELECT m.id, m.content, m.metadata, s."projectId", s."orgId", s."sessionId" AS "externalSessionId"
      FROM messages m JOIN sessions s ON s.id = m."sessionId"
      WHERE s."projectId" IS NOT NULL AND s."orgId" IS NOT NULL
        AND m.metadata->>'source' = 'native_agent_hook'
        AND m.metadata->>'native_capture_state' IN ('pending', 'processing')
        AND COALESCE((m.metadata->>'retry_at')::timestamptz, '-infinity') <= NOW()
      ORDER BY m."createdAt" LIMIT 1 FOR UPDATE OF m SKIP LOCKED
    `;
    const message = rows[0];
    if (!message) return false;
    const attempts = Number(message.metadata.capture_attempts || 0) + 1;
    await tx.$executeRaw`SAVEPOINT native_capture_index`;
    try {
      const documentId = await indexCapture(message, tx);
      await tx.$executeRaw`
        UPDATE messages SET metadata = (metadata - 'last_error' - 'retry_at') || jsonb_build_object(
          'native_capture_state', 'indexed', 'document_id', ${documentId}::text,
          'capture_attempts', ${attempts}::int, 'indexed_at', NOW()
        ) WHERE id = ${message.id}
      `;
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT native_capture_index`;
      const errorText = String(redactCapture(error instanceof Error ? error.message : String(error))).slice(0, 1000);
      const retry = captureRetryPlan(attempts);
      await tx.$executeRaw`
        UPDATE messages SET metadata = metadata || jsonb_build_object(
          'native_capture_state', ${retry.state}::text, 'last_error', ${errorText}::text,
          'capture_attempts', ${attempts}::int,
          'retry_at', ${retry.retryAfterSeconds}::int * INTERVAL '1 second' + clock_timestamp()
        ) WHERE id = ${message.id}
      `;
      if (retry.state === "failed") {
        console.error(`[NativeCapture] Event ${message.id} failed permanently after ${attempts} attempts: ${errorText}`);
      } else {
        console.error(`[NativeCapture] Event ${message.id} will retry: ${errorText}`);
      }
    }
    return true;
  }, { timeout: 180_000, maxWait: 5000 });
}

let draining: Promise<void> | undefined;

export function drainNativeCaptures(): Promise<void> {
  if (!draining) draining = drainBatch().finally(() => { draining = undefined; });
  return draining;
}

async function drainBatch(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    if (!await processNextCapture()) break;
  }
}

export function startNativeCaptureWorker(): () => void {
  const timer = setInterval(() => {
    void drainNativeCaptures().catch(error => console.error("[NativeCapture] Drain failed:", error));
  }, 1000);
  timer.unref();
  void drainNativeCaptures().catch(error => console.error("[NativeCapture] Recovery failed:", error));
  return () => {
    clearInterval(timer);
    void stopNativeEmbeddingProcess();
  };
}
