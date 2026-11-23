import OpenAI from "openai";
import { embedLocal, LOCAL_EMBEDDING_MODEL } from "./embeddings-local.js";
import { embedWithInferenceService } from "./inference-client.js";

export interface EmbeddingBatch {
  vectors: number[][];
  model: string | null;
}

export type Embedder = (texts: string[]) => Promise<EmbeddingBatch | number[][]>;

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when using OpenAI embeddings");
  }
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

// Configuration:
//   'openai'  — OpenAI text-embedding-3-small (1024-dim) [default]
//   'gemini'  — Google text-embedding-004 (768-dim, no in-process model)
//   'local'   — BGE-large in-process (free, but uses RAM/CPU per instance)
//   'hybrid'  — local for small batches, OpenAI for large batches
//   'remote'  — custom inference service
const EMBEDDING_MODE = process.env.EMBEDDING_MODE || 'remote';
const USE_LOCAL_EMBEDDINGS = EMBEDDING_MODE === 'local' || EMBEDDING_MODE === 'hybrid';
const USE_REMOTE_EMBEDDINGS = EMBEDDING_MODE === 'remote' || EMBEDDING_MODE === 'workers';
const REMOTE_INFERENCE_REQUIRED = /^true$/i.test(process.env.REMOTE_INFERENCE_REQUIRED || "false");

// Hybrid mode uses OpenAI for batches above this threshold.
const LARGE_BATCH_THRESHOLD = Number(process.env.LARGE_BATCH_THRESHOLD ?? 20);

// ── OpenAI ──────────────────────────────────────────────────────────────────
async function embedWithOpenAI(texts: string[]): Promise<EmbeddingBatch> {
  const openai = getOpenAIClient();
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
    dimensions: 1024,
  });
  console.log(`[Embeddings] Generated ${res.data.length} OpenAI embeddings`);
  return { vectors: res.data.map((d) => d.embedding), model: res.model || null };
}

// ── Gemini ───────────────────────────────────────────────────────────────────
// Uses Google's text-embedding-004 via REST (no SDK dependency).
// Dimension: 768 (set outputDimensionality to override, max 768).
// NOTE: switching to gemini requires re-indexing existing vectors (768 vs 1024 dims).
const GEMINI_DIMENSIONS = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS ?? 768);
const GEMINI_EMBEDDING_MODEL = "text-embedding-004";

async function embedWithGemini(texts: string[]): Promise<EmbeddingBatch> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is required when EMBEDDING_MODE=gemini");

  // Batch API: up to 100 texts per request
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const requests = batch.map((text) => ({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: GEMINI_DIMENSIONS,
    }));

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini embedding API error ${res.status}: ${err}`);
    }

    const json = (await res.json()) as { embeddings: Array<{ values: number[] }> };
    allEmbeddings.push(...json.embeddings.map((e) => e.values));
  }

  console.log(`[Embeddings] Generated ${allEmbeddings.length} Gemini embeddings (${GEMINI_DIMENSIONS}-dim)`);
  return { vectors: allEmbeddings, model: GEMINI_EMBEDDING_MODEL };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed multiple texts.
 *
 * Modes:
 * - 'openai':  OpenAI text-embedding-3-small, 1024-dim [default]
 * - 'gemini':  Google text-embedding-004, 768-dim — no in-process model, scales to 1000+ users
 * - 'local':   BGE-large in-process, 1024-dim (free but memory-heavy per instance)
 * - 'hybrid':  local for small batches, OpenAI for large batches
 * - 'remote':  custom inference service
 */
async function embedWithModel(texts: string[], single = false): Promise<EmbeddingBatch> {
  if (USE_REMOTE_EMBEDDINGS) {
    try {
      const batch = await embedWithInferenceService(texts);
      console.log(`[Embeddings] Generated ${batch.vectors.length} remote embeddings`);
      return batch;
    } catch (error: any) {
      console.warn('[Embeddings] Remote embedding failed:', error.message);
      if (REMOTE_INFERENCE_REQUIRED) throw error;
    }
  }

  if (EMBEDDING_MODE === 'gemini') {
    return embedWithGemini(texts);
  }

  if (!single && EMBEDDING_MODE === 'hybrid' && texts.length > LARGE_BATCH_THRESHOLD) {
    console.log(`[Embeddings] Batch size ${texts.length} > ${LARGE_BATCH_THRESHOLD}, using OpenAI`);
    return embedWithOpenAI(texts);
  }

  // Explicit local mode keeps every batch local.
  if (USE_LOCAL_EMBEDDINGS) {
    try {
      const embeddings = await embedLocal(texts);
      console.log(`[Embeddings] Generated ${embeddings.length} local embeddings (${LOCAL_EMBEDDING_MODEL})`);
      return { vectors: embeddings, model: LOCAL_EMBEDDING_MODEL };
    } catch (error: any) {
      console.warn('[Embeddings] Local embedding failed, falling back to OpenAI:', error.message);
      if (EMBEDDING_MODE === 'local') throw error;
    }
  }

  return embedWithOpenAI(texts);
}

/** An injected vector-only embedder does not establish which model produced its result. */
export async function embedBatch(texts: string[], embedder: Embedder = embedWithModel): Promise<EmbeddingBatch> {
  const result = await embedder(texts);
  return Array.isArray(result) ? { vectors: result, model: null } : result;
}

export async function embed(texts: string[]): Promise<number[][]> {
  return (await embedBatch(texts)).vectors;
}

export async function embedSingle(text: string): Promise<number[]> {
  return (await embedWithModel([text], true)).vectors[0];
}
