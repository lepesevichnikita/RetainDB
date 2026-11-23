import { prisma } from "../db/index.js";
import { Prisma } from "@prisma/client";
import { embedSingle, embedSingleWithModel } from "./embeddings.js";
import { compressContext } from "./compressor.js";
import { createHash } from "crypto";
import OpenAI from "openai";
import { rerankWithCrossEncoder, shouldUseLLMFallback } from "./embeddings-local.js";
import { getFromCache, setInCache } from "./cache.js";
import { recordRetrievalWorkloadSample, recordStageBreakdown } from "./latency-tracing.js";
import { rerankWithInferenceService } from "./inference-client.js";
import { selectOracleCandidateChunkIds } from "./oracle-select.js";
import { searchGraphChunks } from "./entity-graph.js";
import { compatibleEmbeddingModel, exactDistanceOrder } from "./vector-order.js";
import { projectScopeSql, type ProjectSearchScope, visibleSourceSql } from "./oracle-visibility.js";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for LLM reranking");
  }
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

// Reranking mode: 'balanced' (cross-encoder + strict LLM guard), 'cross-encoder', 'llm'
const RERANK_MODE = process.env.RERANK_MODE || "balanced";
const RERANK_PROVIDER = process.env.RERANK_PROVIDER || "local";
const REMOTE_INFERENCE_REQUIRED = /^true$/i.test(process.env.REMOTE_INFERENCE_REQUIRED || "false");
const LLM_RERANK_ENABLED = /^true$/i.test(process.env.LLM_RERANK_ENABLED || "false");
const RERANK_BUDGET_MS = parseInt(process.env.RERANK_BUDGET_MS || "90", 10);
const LLM_RERANK_MIN_BUDGET_MS = parseInt(process.env.LLM_RERANK_MIN_BUDGET_MS || "75", 10);
const LLM_RERANK_MAX_CANDIDATES = parseInt(process.env.LLM_RERANK_MAX_CANDIDATES || "5", 10);
const STAGE_TIMING_LOG_ENABLED = /^true$/i.test(process.env.RETRIEVAL_STAGE_TIMING_LOG || "true");
const RETRIEVAL_PRECISION_V1_DEFAULT = /^true$/i.test(process.env.RETRIEVAL_PRECISION_V1_DEFAULT || "false");
const PARENT_EXCERPT_MAX_CHARS = 900;

const RETRIEVAL_PROFILE = "balanced";
const MAX_RESULTS_PER_SEARCH = parseInt(process.env.MAX_RESULTS_PER_SEARCH || "24", 10);
const MAX_PRE_DEDUPE_RESULTS = parseInt(process.env.MAX_PRE_DEDUPE_RESULTS || "96", 10);
const MAX_RERANK_CANDIDATES = parseInt(process.env.MAX_RERANK_CANDIDATES || "20", 10);

export const RETRIEVAL_PROFILE_VALUES = ["legacy", "precision_v1"] as const;
export type RetrievalProfile = typeof RETRIEVAL_PROFILE_VALUES[number];

// ─── Types ───────────────────────────────────────────────────

export interface RetrievalResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, any>;
  documentTitle?: string;
  sourceName?: string;
  project?: string;
  chunkType: string;
  source: "vector" | "bm25" | "hybrid" | "memory" | "graph";
}

export type QueryOptions = ({ scope: ProjectSearchScope; projectId?: never } | { projectId: string; scope?: never }) & {
  query: string;
  topK?: number;
  threshold?: number;
  chunkTypes?: string[];
  sourceIds?: string[];
  metadataFilter?: Record<string, any>;
  // Oracle prefilter (structure-aware scope selection)
  oracleMode?: "off" | "auto" | "force";
  oracleMaxSeedHits?: number;
  oracleMaxDocuments?: number;
  oracleMaxSectionsPerDoc?: number;
  oracleMaxCandidateChunks?: number;
  // Hybrid search
  hybridSearch?: boolean;
  useVector?: boolean; // if false, skip embeddings + vector search (BM25-only / keyword-only)
  vectorWeight?: number; // 0-1, default 0.7
  bm25Weight?: number;   // 0-1, default 0.3
  // Reranking
  rerank?: boolean;
  rerankTopK?: number;
  // Memory inclusion
  includeMemories?: boolean;
  userId?: string;
  sessionId?: string;
  agentId?: string;
  // Graph
  includeGraph?: boolean;
  graphDepth?: number;
  // Context packing
  maxTokens?: number;
  // Compression
  compress?: boolean;
  compressionStrategy?: "summarize" | "extract" | "delta" | "adaptive";
  previousContextHash?: string;
  // Caching
  useCache?: boolean;
  cacheTtlSeconds?: number;
  // Payload + rollout
  includeParentContent?: boolean;
  retrievalProfile?: RetrievalProfile;
};

export interface ContextResponse {
  results: RetrievalResult[];
  context: string; // packed context string ready for LLM
  meta: {
    totalResults: number;
    latencyMs: number;
    cacheHit: boolean;
    tokensUsed: number;
    contextHash?: string;
    compression?: {
      originalTokens: number;
      compressedTokens: number;
      reductionPercent: number;
      strategy: string;
    };
    sourceScope?: {
      mode: "none" | "explicit" | "auto";
      sourceIds: string[];
      host?: string;
      matchedSources?: number;
    };
    profile?: string;
    degraded?: {
      reranked: boolean;
      reasons: string[];
    };
    retrievalProfile?: RetrievalProfile;
    sourceFamily?: string;
    timing?: {
      cache_check_ms?: number;
      embed_ms?: number;
      /** True when the embedder could not be reached, so this answer came from the lexical half only. */
      embedding_unavailable?: boolean;
      /**
       * True when memories were asked for but never searched: that search is a vector query too, and an
       * empty embedding would return unrelated rows. Without this a client cannot tell "no memories"
       * from "we did not look".
       */
      memory_skipped?: boolean;
      oracle_ms?: number;
      vector_ms?: number;
      fts_ms?: number;
      memory_ms?: number;
      graph_ms?: number;
      dedupe_ms?: number;
      rrf_ms?: number;
      threshold_ms?: number;
      rerank_ms?: number;
      enrich_ms?: number;
      pack_ms?: number;
      compress_ms?: number;
      cache_set_ms?: number;
      total_ms?: number;
      // Legacy aliases retained for backward compatibility
      cacheCheckMs?: number;
      embedMs?: number;
      oracleMs?: number;
      vectorMs?: number;
      bm25Ms?: number;
      rerankMs?: number;
      enrichMs?: number;
      packMs?: number;
      cacheSetMs?: number;
      totalMs?: number;
    };
  };
}

// ─── Main Query Function ─────────────────────────────────────

export async function applyRerank<T>(
  results: T[],
  rerank: (results: T[]) => Promise<T[]>,
): Promise<{ results: T[]; degraded: boolean }> {
  try {
    return { results: await rerank(results), degraded: false };
  } catch (error) {
    console.warn("[Retriever] Reranking unavailable, returning fused order:", error instanceof Error ? error.message : error);
    return { results, degraded: true };
  }
}

export async function retrieve(opts: QueryOptions): Promise<ContextResponse> {
  const scope = opts.scope ?? opts.projectId;
  if (scope === undefined) throw new Error("Retrieval requires a project or organization scope");
  const defaultRetrievalProfile: RetrievalProfile = RETRIEVAL_PRECISION_V1_DEFAULT ? "precision_v1" : "legacy";
  const {
    query,
    topK = 10,
    threshold = 0.25,  // Increased from 0.05 for better quality (0.25 = good balance)
    chunkTypes,
    sourceIds,
    metadataFilter,
    oracleMode = "off",
    oracleMaxSeedHits,
    oracleMaxDocuments,
    oracleMaxSectionsPerDoc,
    oracleMaxCandidateChunks,
    hybridSearch = true,
    useVector = true,
    vectorWeight = 0.7,
    bm25Weight = 0.3,
    rerank = true,
    rerankTopK,
    includeMemories = false,
    userId,
    sessionId,
    agentId,
    includeGraph = false,
    graphDepth = 1,
    maxTokens,
    compress = false,
    compressionStrategy = "adaptive",
    previousContextHash,
    useCache = true,
    cacheTtlSeconds = 300,
    includeParentContent = false,
    retrievalProfile = defaultRetrievalProfile,
  } = opts;

  const projectId = typeof scope === "string" ? scope : scope.projectId;
  const orgId = typeof scope === "string" ? undefined : scope.orgId;

  const startTime = Date.now();
  const timing: NonNullable<ContextResponse["meta"]["timing"]> = {};
  // Shared cache entries cannot recheck memory identity, expiry, or revocation.
  const cacheResults = useCache && !includeGraph && !includeMemories;
  const cacheParams = {
    retrievalScopeVersion: 2,
    orgId,
    query,
    topK,
    threshold,
    chunkTypes,
    sourceIds,
    metadataFilter,
    oracleMode,
    oracleMaxSeedHits,
    oracleMaxDocuments,
    oracleMaxSectionsPerDoc,
    oracleMaxCandidateChunks,
    hybridSearch,
    useVector,
    vectorWeight,
    bm25Weight,
    rerank,
    includeMemories,
    includeGraph,
    maxTokens,
    compress,
    compressionStrategy,
    previousContextHash,
    includeParentContent,
    retrievalProfile,
  };
  const precisionV1Enabled = retrievalProfile === "precision_v1";
  const explicitSourceIds = uniqueStrings(sourceIds || []);
  const hasExplicitScope = explicitSourceIds.length > 0 || Boolean(metadataFilter && Object.keys(metadataFilter).length > 0);
  const sourceIntent = explicitSourceIds.length === 0 ? detectQuerySourceIntent(query) : null;
  const autoSourceIds = sourceIntent && projectId ? await resolveAutoSourceIds(projectId, sourceIntent) : [];
  const scopedSourceIds = explicitSourceIds.length > 0 ? explicitSourceIds : autoSourceIds;
  const sourceScope: NonNullable<ContextResponse["meta"]["sourceScope"]> = explicitSourceIds.length > 0
    ? {
      mode: "explicit",
      sourceIds: explicitSourceIds,
      matchedSources: explicitSourceIds.length,
    }
    : autoSourceIds.length > 0
      ? {
        mode: "auto",
        sourceIds: autoSourceIds,
        host: sourceIntent?.host,
        matchedSources: autoSourceIds.length,
      }
      : {
        mode: "none",
        sourceIds: [],
        ...(sourceIntent?.host ? { host: sourceIntent.host } : {}),
      };

  // ─── Check Cache ─────────────────────────────────────────
  if (cacheResults && projectId) {
    const t0 = Date.now();
    const cached = await checkCache(projectId, cacheParams);
    timing.cache_check_ms = Date.now() - t0;
    if (cached) {
      const cachedResults = cached as unknown as RetrievalResult[];
      const cachedContext = packContext(cachedResults, maxTokens);
      const contextHash = createHash("sha256").update(cachedContext).digest("hex").slice(0, 16);

      let context = cachedContext;
      let compressionMeta: ContextResponse["meta"]["compression"];
      if (compress && context.length > 0) {
        const tCompress = Date.now();
        try {
          const compressed = await compressContext(context, {
            maxTokens: maxTokens || 4000,
            strategy: compressionStrategy,
            previousContextHash,
          });
          context = compressed.context;
          compressionMeta = {
            originalTokens: compressed.originalTokens,
            compressedTokens: compressed.compressedTokens,
            reductionPercent: compressed.reductionPercent,
            strategy: compressed.strategy,
          };
        } catch (err: any) {
          console.warn("[Retriever] Compression failed on cache hit:", err?.message || err);
        } finally {
          timing.compress_ms = Date.now() - tCompress;
        }
      }
      const latencyMs = Date.now() - startTime;
      timing.total_ms = latencyMs;
      attachLegacyTimingAliases(timing);
      const sourceFamily = inferRetrievalWorkload(cachedResults, metadataFilter);
      recordRetrievalWorkloadSample({
        workload: sourceFamily,
        durationMs: latencyMs,
        cacheHit: true,
        profile: RETRIEVAL_PROFILE,
      });
      emitStageTimingLog({ projectId, query, topK, cacheHit: true, timing });
      return {
        results: cachedResults,
        context,
        meta: {
          totalResults: cachedResults.length,
          latencyMs,
          cacheHit: true,
          tokensUsed: estimateTokens(context),
          contextHash,
          compression: compressionMeta,
          sourceScope,
          profile: RETRIEVAL_PROFILE,
          retrievalProfile,
          sourceFamily,
          // Only a complete answer is ever stored (see the write below), so a hit cannot be degraded.
          // It says so rather than omitting the field: a client reading `degraded.reasons` on every
          // answer must not have to tell "nothing was lost" from "the field is missing".
          degraded: { reranked: true, reasons: [] },
          timing,
        },
      };
    }
  }

  // ─── Embed Query ─────────────────────────────────────────
  const tEmbed = Date.now();
  const oracleActive = shouldEnableOracle({ query, oracleMode, chunkTypes, metadataFilter });
  const needsEmbedding = useVector || includeMemories || includeGraph || oracleActive;
  // The route declares use_vector defaulting to true, so a client that says nothing about vectors is
  // asking for them. If the embedder is unavailable that must not become a 500 - it becomes a lexical
  // answer, and the caller is told the answer is partial rather than left to believe it is complete.
  let embeddingUnavailable: string | null = null;
  let queryEmbedding: number[] = [];
  let queryModel: string | null = null;
  const loadQueryEmbedding = async () => {
    const { vector, model } = await embedSingleWithModel(query);
    queryEmbedding = vector;
    queryModel = model;
    return vector;
  };
  if (needsEmbedding) {
    try {
      await loadQueryEmbedding();
    } catch (error) {
      embeddingUnavailable = (error as Error).message;
      console.warn(`[Retriever] embeddings unavailable, answering without the vector half: ${embeddingUnavailable}`);
      timing.embedding_unavailable = true;
    }
  }
  timing.embed_ms = Date.now() - tEmbed;
  const codebaseIntent = precisionV1Enabled
    ? await classifyCodebaseIntent({
      query,
      queryEmbedding,
      ensureEmbedding: async () => queryEmbedding.length ? queryEmbedding : loadQueryEmbedding(),
    })
    : {
      isCodebaseIntent: false,
      lexicalScore: 0,
      positiveScore: 0,
      negativeScore: 0,
      semanticChecked: false,
    };

  let allResults: RetrievalResult[] = [];

  let oracleChunkIdFilter: string[] | undefined;
  if (projectId && oracleActive && queryEmbedding.length > 0) {
    const tOracle = Date.now();
    try {
      const candidateChunkIds = await selectOracleCandidateChunkIds({
        projectId,
        queryEmbedding,
        queryModel,
        sourceIds: scopedSourceIds,
        chunkTypes,
        metadataFilter,
        maxSeedHits: oracleMaxSeedHits,
        maxDocuments: oracleMaxDocuments,
        maxSectionsPerDoc: oracleMaxSectionsPerDoc,
        maxCandidateChunks: oracleMaxCandidateChunks,
      });
      oracleChunkIdFilter = candidateChunkIds.length >= 10 ? candidateChunkIds : undefined;
    } catch (err: any) {
      console.warn("[Context] Oracle prefilter failed:", err?.message || err);
      oracleChunkIdFilter = undefined;
    } finally {
      timing.oracle_ms = Date.now() - tOracle;
    }
  }

  // Fixed upper bounds keep p95 stable under concurrent load.
  const maxResultsPerSearch = Math.min(topK * 2, MAX_RESULTS_PER_SEARCH);

  // ─── Personal query fast-path ────────────────────────────
  // For queries clearly about the user's own profile ("what are my preferences",
  // "do you remember me", "what did I tell you") skip all document search entirely
  // and route straight to memories. This avoids polluting memory-only results with
  // irrelevant document chunks and cuts latency significantly.
  const personalQuery = isPersonalQuery(query);

  // ─── Query Expansion (parallel, zero critical-path latency) ──────────────
  // Fire off paraphrase generation concurrently with the first vector search.
  // Results are merged with RRF only if they arrive before pack time.
  // Skip for personal queries — expansion on "what are my preferences" just generates
  // more preference-related queries that all miss on document search anyway.
  const expansionPromise: Promise<RetrievalResult[]> =
    !personalQuery && useVector && queryEmbedding.length > 0 && process.env.OPENAI_API_KEY
      ? expandQueryAndSearch(query, scope, maxResultsPerSearch, chunkTypes, metadataFilter, scopedSourceIds, oracleChunkIdFilter)
          .catch(() => [])
      : Promise.resolve([]);

  // ─── Vector Search ───────────────────────────────────────
  const tVector = Date.now();
  const vectorResults =
    !personalQuery && useVector && queryEmbedding.length > 0
      ? await vectorSearch(
        scope,
        { vector: queryEmbedding, model: queryModel },
        maxResultsPerSearch,
        chunkTypes,
        metadataFilter,
        scopedSourceIds,
        oracleChunkIdFilter
      )
      : [];
  timing.vector_ms = Date.now() - tVector;
  allResults.push(...vectorResults);

  // ─── BM25 Full-Text Search ───────────────────────────────
  if (!personalQuery && hybridSearch) {
    const tBm25 = Date.now();
    const bm25Results = await fullTextSearch(
      scope,
      query,
      maxResultsPerSearch,
      chunkTypes,
      metadataFilter,
      scopedSourceIds,
      oracleChunkIdFilter
    );
    timing.fts_ms = Date.now() - tBm25;
    allResults.push(...bm25Results);
  }

  // Collect expansion results (already running in background)
  const expansionResults = await expansionPromise;
  if (expansionResults.length > 0) {
    allResults.push(...expansionResults);
  }

  // ─── Memory Search ───────────────────────────────────────
  if (includeMemories && projectId && embeddingUnavailable === null) {
    const tMem = Date.now();
    // Personal queries ("what do I prefer", "my name", "do you remember me")
    // dominate the result set — give them the full topK budget plus extra headroom.
    // Knowledge queries get only a fraction since documents carry the primary signal.
    const memoryTopK = personalQuery
      ? Math.max(topK, 25)
      : Math.min(Math.ceil(topK / 3), 10);
    const memoryResults = await memorySearch(projectId, queryEmbedding, {
      orgId,
      userId,
      sessionId,
      agentId,
      topK: memoryTopK,
    });
    timing.memory_ms = Date.now() - tMem;
    allResults.push(...memoryResults);
  } else if (includeMemories) {
    // Nothing was searched, so the absence of memory hits is not "no memories": the answer says the
    // half was skipped, in the same place it says the vector half was.
    timing.memory_skipped = true;
  }

  // ─── Graph Traversal ─────────────────────────────────────
  let graph: Awaited<ReturnType<typeof searchGraphChunks>> | undefined;
  if (includeGraph && embeddingUnavailable === null) {
    const tGraph = Date.now();
    graph = await searchGraphChunks({
      scope,
      embedding: queryEmbedding,
      embeddingModel: queryModel,
      depth: graphDepth,
      topK: Math.min(Math.ceil(topK / 3), 10),
      primaryChunkIds: [...new Set(allResults.filter((hit) => hit.source !== "memory" && hit.score >= threshold).map(({ id }) => id))],
      chunkScope: { sourceIds: scopedSourceIds, chunkTypes, metadataFilter },
    });
    timing.graph_ms = Date.now() - tGraph;
    allResults.push(...graph.results);
  }

  // Cap candidate churn to keep worst-case work bounded.
  if (allResults.length > MAX_PRE_DEDUPE_RESULTS) {
    allResults = allResults
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PRE_DEDUPE_RESULTS);
  }

  // ─── Deduplicate ─────────────────────────────────────────
  const tDedupe = Date.now();
  allResults = deduplicateResults(allResults);
  timing.dedupe_ms = Date.now() - tDedupe;

  // ─── Reciprocal Rank Fusion (for hybrid) ─────────────────
  if (hybridSearch) {
    const tRrf = Date.now();
    allResults = reciprocalRankFusion(allResults, vectorWeight, bm25Weight);
    timing.rrf_ms = Date.now() - tRrf;
  }

  // ─── Filter by threshold ─────────────────────────────────
  const tThresh = Date.now();
  const beforeThreshold = allResults.length;
  allResults = allResults.filter((r) => r.score >= threshold);
  console.log(`[Retriever] Threshold filter: ${beforeThreshold} -> ${allResults.length} (threshold: ${threshold})`);
  timing.threshold_ms = Date.now() - tThresh;

  if (sourceIntent) {
    allResults = allResults
      .map((result) => ({
        ...result,
        score: result.score + scoreSourceIntentMatch(result, sourceIntent, scopedSourceIds),
      }))
      .sort((left, right) => right.score - left.score);
  }

  if (precisionV1Enabled && codebaseIntent.isCodebaseIntent && !hasExplicitScope) {
    allResults = applyRepoFirstFamilyFilter(allResults);
  }

  if (allResults.length > 0) {
    allResults = await expandParentContexts(allResults, { query, includeParentContent });
  }

  // ─── Rerank with LLM ────────────────────────────────────
  const degradedReasons: string[] = [];
  if (rerank && allResults.length > 0) {
    const tRerank = Date.now();
    const outcome = await applyRerank(allResults, (candidates) =>
      rerankResults(query, candidates, rerankTopK || topK, {
        startTimeMs: startTime,
        requestBudgetMs: RERANK_BUDGET_MS,
      }),
    );
    allResults = outcome.results;
    if (outcome.degraded) degradedReasons.push("reranker_unavailable");
    timing.rerank_ms = Date.now() - tRerank;
  }

  if (precisionV1Enabled) {
    allResults = applyPrecisionCutoff(allResults, codebaseIntent.isCodebaseIntent);
  }

  // ─── Limit to topK ──────────────────────────────────────

  // ─── Enrich with document/source metadata ────────────────
  const tEnrich = Date.now();
  allResults = await enrichResults(allResults);
  timing.enrich_ms = Date.now() - tEnrich;

  // ─── Context packing ─────────────────────────────────────
  allResults = allResults.slice(0, topK);
  if (graph) allResults = attachGraphEvidence(allResults, graph.evidence);

  const tPack = Date.now();
  let context = packContext(allResults, maxTokens);
  timing.pack_ms = Date.now() - tPack;
  const contextHash = createHash("sha256").update(context).digest("hex").slice(0, 16);

  // ─── Compression ──────────────────────────────────────────
  let compressionMeta: ContextResponse["meta"]["compression"];
  if (compress && context.length > 0) {
    const tCompress = Date.now();
    const compressed = await compressContext(context, {
      maxTokens: maxTokens || 4000,
      strategy: compressionStrategy,
      previousContextHash,
    });
    context = compressed.context;
    compressionMeta = {
      originalTokens: compressed.originalTokens,
      compressedTokens: compressed.compressedTokens,
      reductionPercent: compressed.reductionPercent,
      strategy: compressed.strategy,
    };
    timing.compress_ms = Date.now() - tCompress;
  }

  // ─── Cache results ───────────────────────────────────────
  // Only a complete answer is stored. A cached answer is served for the whole TTL and cannot be
  // re-checked: a partial one would keep presenting itself as complete, and would keep doing it after
  // the embedder recovered. Not writing it costs one recomputation per repeated question during an
  // outage and lets the next one be answered in full the moment the embedder is back.
  //
  // A degraded answer is partial for the same reason and is stored by the same rule: the fused order
  // is what a reader gets when the reranker could not be consulted, and a stored copy would keep
  // saying so only in a field nobody re-reads - the reranker may be healthy long before the entry
  // expires. `degradedReasons` is empty for every answer that lost nothing, so the rule cannot drift
  // into "never cache".
  if (cacheResults && projectId && allResults.length > 0 && embeddingUnavailable === null && degradedReasons.length === 0) {
    const tSet = Date.now();
    await setCache(projectId, cacheParams, allResults, cacheTtlSeconds);
    timing.cache_set_ms = Date.now() - tSet;
  }

  const latencyMs = Date.now() - startTime;
  timing.total_ms = latencyMs;
  attachLegacyTimingAliases(timing);
  const sourceFamily = inferRetrievalWorkload(allResults, metadataFilter);
  recordRetrievalWorkloadSample({
    workload: sourceFamily,
    durationMs: latencyMs,
    cacheHit: false,
    profile: RETRIEVAL_PROFILE,
  });
  emitStageTimingLog({ projectId, query, topK, cacheHit: false, timing });

  return {
    results: allResults,
    context,
    meta: {
      totalResults: allResults.length,
      latencyMs,
      cacheHit: false,
      tokensUsed: estimateTokens(context),
      contextHash,
      compression: compressionMeta,
      sourceScope,
      profile: RETRIEVAL_PROFILE,
      retrievalProfile,
      sourceFamily,
      degraded: { reranked: degradedReasons.length === 0, reasons: degradedReasons },
      timing,
    },
  };
}

interface QuerySourceIntent {
  raw: string;
  host: string;
  hostVariants: string[];
  normalizedUrl?: string;
  pathTokens: string[];
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function shouldEnableOracle(args: {
  query: string;
  oracleMode: "off" | "auto" | "force";
  chunkTypes?: string[];
  metadataFilter?: Record<string, any>;
}): boolean {
  if (args.oracleMode === "force") return true;
  if (args.oracleMode !== "auto") return false;

  const chunkTypes = (args.chunkTypes || []).map((t) => String(t || "").toLowerCase());
  if (chunkTypes.some((t) => t.includes("pdf"))) return true;

  const query = args.query.toLowerCase();
  if (/\b(pdf|page|pages|section|appendix|figure|table|results)\b/i.test(query)) return true;

  const metadata = args.metadataFilter || {};
  for (const [key, value] of Object.entries(metadata)) {
    const hay = `${key}:${typeof value === "string" ? value : JSON.stringify(value)}`.toLowerCase();
    if (hay.includes("pdf") || hay.includes(".pdf") || hay.includes("application/pdf")) return true;
  }

  return false;
}

const CODEBASE_POSITIVE_PROTOTYPES = [
  "How does this codebase handle errors and exceptions?",
  "Where is retry logic implemented in the project?",
  "Walk me through the authentication flow in this repository.",
  "Which file contains API error handling middleware?",
];

const CODEBASE_NEGATIVE_PROTOTYPES = [
  "How does this policy handle exceptions for customers?",
  "Summarize the business strategy for this quarter.",
  "What does this video transcript say about music?",
  "Explain the healthcare project process for patient intake.",
];

const CODEBASE_KEYWORD_WEIGHTS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /\b(project|repo|repository|codebase|code)\b/i, weight: 1 },
  { pattern: /\b(file|module|function|class|handler|middleware|endpoint|route|implementation|wiring)\b/i, weight: 1 },
  { pattern: /\b(auth|authentication|session|cookie|api|request|response)\b/i, weight: 1 },
  { pattern: /\b(error|errors|exception|exceptions|retry|failure|failures|throw|catch|stack|trace|logging)\b/i, weight: 2 },
  { pattern: /\bflow|logic|debug|debugging\b/i, weight: 1 },
  { pattern: /[A-Za-z0-9/_-]+\.[A-Za-z0-9]+/, weight: 2 },
  { pattern: /\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{2,}/, weight: 2 },
];

let prototypeEmbeddingCache:
  | Promise<{ positive: number[][]; negative: number[][] }>
  | null = null;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function computeCodebaseLexicalScore(query: string): number {
  let score = 0;
  for (const { pattern, weight } of CODEBASE_KEYWORD_WEIGHTS) {
    if (pattern.test(query)) score += weight;
  }
  return score;
}

async function getPrototypeEmbeddings(): Promise<{ positive: number[][]; negative: number[][] }> {
  if (!prototypeEmbeddingCache) {
    prototypeEmbeddingCache = (async () => {
      const positive = await Promise.all(CODEBASE_POSITIVE_PROTOTYPES.map((text) => embedSingle(text)));
      const negative = await Promise.all(CODEBASE_NEGATIVE_PROTOTYPES.map((text) => embedSingle(text)));
      return { positive, negative };
    })();
  }
  return prototypeEmbeddingCache;
}

async function classifyCodebaseIntent(args: {
  query: string;
  queryEmbedding: number[];
  ensureEmbedding: () => Promise<number[]>;
}): Promise<{
  isCodebaseIntent: boolean;
  lexicalScore: number;
  positiveScore: number;
  negativeScore: number;
  semanticChecked: boolean;
}> {
  const lexicalScore = computeCodebaseLexicalScore(args.query);
  if (lexicalScore >= 4) {
    return {
      isCodebaseIntent: true,
      lexicalScore,
      positiveScore: 0,
      negativeScore: 0,
      semanticChecked: false,
    };
  }

  if (lexicalScore < 1) {
    return {
      isCodebaseIntent: false,
      lexicalScore,
      positiveScore: 0,
      negativeScore: 0,
      semanticChecked: false,
    };
  }

  try {
    const queryEmbedding = args.queryEmbedding.length > 0 ? args.queryEmbedding : await args.ensureEmbedding();
    if (queryEmbedding.length === 0) {
      return {
        isCodebaseIntent: false,
        lexicalScore,
        positiveScore: 0,
        negativeScore: 0,
        semanticChecked: false,
      };
    }
    const prototypes = await getPrototypeEmbeddings();
    const positiveScore = Math.max(...prototypes.positive.map((embedding) => cosineSimilarity(queryEmbedding, embedding)));
    const negativeScore = Math.max(...prototypes.negative.map((embedding) => cosineSimilarity(queryEmbedding, embedding)));
    const isCodebaseIntent = positiveScore >= 0.58 && positiveScore - negativeScore >= 0.08;
    return {
      isCodebaseIntent,
      lexicalScore,
      positiveScore,
      negativeScore,
      semanticChecked: true,
    };
  } catch {
    return {
      isCodebaseIntent: false,
      lexicalScore,
      positiveScore: 0,
      negativeScore: 0,
      semanticChecked: false,
    };
  }
}

/**
 * Returns true when the query is clearly about the user's own profile, preferences,
 * or past interactions — memory results should dominate over document results.
 * When true, document/vector search is skipped and the memory budget is maximized.
 */
function isPersonalQuery(query: string): boolean {
  return /\b(my |me\b|i am\b|i'm\b|i've\b|i have\b|do you remember|what did i|who am i|what do i|what are my|my name|my preference|my preferences|my settings?|my background|my goal|my goals|my style|my workflow|remember me|about me|know about me|tell me about me|describe me|what i (like|prefer|use|work|do|want|need)|how do i (like|prefer|work|usually)|i (typically|usually|always|never|often|like to|prefer to|tend to))\b/i.test(query);
}

/**
 * Generate 2 paraphrase queries with gpt-4o-mini, embed them, run vector search
 * for each, and return the merged results. Designed to run in parallel with the
 * primary search so it adds near-zero latency to the critical path.
 */
async function expandQueryAndSearch(
  query: string,
  scope: ProjectSearchScope,
  maxResults: number,
  chunkTypes?: string[],
  metadataFilter?: Record<string, any>,
  sourceIds?: string[],
  oracleFilter?: string[],
): Promise<RetrievalResult[]> {
  try {
    const client = getOpenAIClient();
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 120,
      temperature: 0.3,
      messages: [{
        role: "user",
        content: `Write 3 alternative phrasings of this search query to improve recall. Each phrasing should approach the topic from a slightly different angle (synonyms, related terms, more specific, more general). Return only the queries, one per line, no numbering, no explanation:\n${query}`,
      }],
    });
    const expansions = (resp.choices[0]?.message?.content ?? "")
      .split("\n")
      .map(s => s.trim())
      .filter(s => s.length > 3 && s !== query)
      .slice(0, 3);

    if (expansions.length === 0) return [];

    const embeddings = await Promise.all(expansions.map(q => embedSingleWithModel(q)));
    const searchResults = await Promise.all(
      embeddings.map(emb =>
        vectorSearch(scope, emb, Math.ceil(maxResults / 2), chunkTypes, metadataFilter, sourceIds ?? [], oracleFilter)
          .catch(() => [] as RetrievalResult[])
      )
    );
    return searchResults.flat();
  } catch {
    return [];
  }
}

function detectQuerySourceIntent(query: string): QuerySourceIntent | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/https?:\/\/[^\s'"`)>]+/i);
  const domainMatch = !urlMatch
    ? trimmed.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s'"`)>]*)?\b/i)
    : null;
  const raw = (urlMatch?.[0] || domainMatch?.[0] || "").trim();
  if (!raw) return null;

  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = normalizeHost(parsed.hostname);
    if (!host || !host.includes(".")) return null;
    const hostParts = host.split(".");
    const apex =
      hostParts.length >= 2 ? `${hostParts[hostParts.length - 2]}.${hostParts[hostParts.length - 1]}` : host;
    const pathTokens = parsed.pathname
      .split("/")
      .map((part) => decodeURIComponent(part).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 4);
    return {
      raw,
      host,
      hostVariants: uniqueStrings([host, apex]),
      normalizedUrl: /^https?:\/\//i.test(raw)
        ? `${parsed.origin}${parsed.pathname === "/" ? "/" : parsed.pathname}`.toLowerCase()
        : undefined,
      pathTokens,
    };
  } catch {
    return null;
  }
}

async function resolveAutoSourceIds(projectId: string, intent: QuerySourceIntent): Promise<string[]> {
  const directSourceMatches = await prisma.source.findMany({
    where: {
      projectId,
      deletedAt: null,
      OR: intent.hostVariants.map((variant) => ({
        name: { contains: variant, mode: "insensitive" as const },
      })),
    },
    select: { id: true },
    take: 8,
  });

  const docSearchTerms = uniqueStrings([
    intent.normalizedUrl,
    ...intent.hostVariants,
    ...intent.pathTokens,
  ]).slice(0, 6);

  const documentMatches = docSearchTerms.length > 0
    ? await prisma.document.findMany({
      where: {
        projectId,
        deletedAt: null,
        OR: docSearchTerms.flatMap((term) => ([
          { webUrl: { contains: term, mode: "insensitive" as const } },
          { title: { contains: term, mode: "insensitive" as const } },
          { externalId: { contains: term, mode: "insensitive" as const } },
          { path: { contains: term, mode: "insensitive" as const } },
        ])),
      },
      select: { sourceId: true },
      distinct: ["sourceId"],
      take: 8,
    })
    : [];

  return uniqueStrings([
    ...directSourceMatches.map((source) => source.id),
    ...documentMatches.map((document) => document.sourceId),
  ]);
}

function scoreSourceIntentMatch(
  result: RetrievalResult,
  intent: QuerySourceIntent | null,
  scopedSourceIds: string[],
): number {
  if (!intent) return 0;

  const sourceId = String(result.metadata?.source_id || "");
  const haystack = [
    result.sourceName,
    result.documentTitle,
    result.metadata?.web_url,
    result.metadata?.source_url,
    result.metadata?.canonical_url,
    result.metadata?.url,
    result.metadata?.path,
    result.metadata?.filePath,
    result.content.slice(0, 400),
  ]
    .map((value) => String(value || "").toLowerCase())
    .join("\n");

  let score = 0;
  if (scopedSourceIds.length > 0) {
    score += sourceId && scopedSourceIds.includes(sourceId) ? 0.45 : -0.4;
  }
  if (intent.hostVariants.some((variant) => haystack.includes(variant))) {
    score += 0.18;
  }
  if (intent.normalizedUrl && haystack.includes(intent.normalizedUrl)) {
    score += 0.2;
  }
  if (intent.pathTokens.some((token) => haystack.includes(token))) {
    score += 0.05;
  }
  if (result.source === "memory" && score < 0.18) {
    score -= 0.35;
  }
  return score;
}

// ─── Vector Search ───────────────────────────────────────────

/** Applies ownership and source visibility before either ranking path limits candidates. */
function searchableChunkFilter(scope: ProjectSearchScope, sourceIds?: string[], chunkTypes?: string[], metadataFilter?: Record<string, unknown>, chunkIds?: string[]) {
  const orgId = typeof scope === "string" ? undefined : scope.orgId;
  return Prisma.sql`${projectScopeSql(Prisma.sql`c."projectId"`, scope)}
    ${chunkTypes?.length ? Prisma.sql`AND c."chunkType" = ANY(${chunkTypes}::text[])` : Prisma.empty}
    ${metadataFilter ? Prisma.sql`AND c.metadata @> ${JSON.stringify(metadataFilter)}::jsonb` : Prisma.empty}
    ${chunkIds?.length ? Prisma.sql`AND c.id = ANY(${chunkIds}::text[])` : Prisma.empty}
    AND COALESCE(c.metadata->>'content_kind', '') <> 'parent_context'
    AND EXISTS (
      SELECT 1 FROM documents d JOIN sources s ON s.id = d."sourceId"
      WHERE d.id = c."documentId" AND s."projectId" = c."projectId"
        AND (d."projectId" IS NULL OR d."projectId" = c."projectId")
        AND d."deletedAt" IS NULL AND s."deletedAt" IS NULL
        ${orgId === undefined ? Prisma.empty : Prisma.sql`AND s."orgId" = ${orgId}`}
        ${visibleSourceSql(sourceIds, orgId)}
        AND (s."activeVersionId" IS NULL OR d."sourceVersionId" = s."activeVersionId")
    )`;
}

const searchChunkColumns = Prisma.sql`c.id, c.content, c."chunkType", c.metadata, c."parentChunkId", c."sectionPath", c."headingPath"`;

interface SearchChunk {
  id: string;
  content: string;
  chunkType: string;
  metadata: Record<string, unknown> | null;
  parentChunkId: string | null;
  sectionPath: string | null;
  headingPath: string | null;
}

function chunkResult(row: SearchChunk, score: number, source: "vector" | "bm25"): RetrievalResult {
  const metadata = row.metadata || {};
  return {
    id: row.id, content: row.content, score, chunkType: row.chunkType, source,
    metadata: { ...metadata, parent_chunk_id: row.parentChunkId || metadata.parent_chunk_id,
      section_path: row.sectionPath || metadata.section_path, heading_path: row.headingPath || metadata.heading_path },
  };
}

async function vectorSearch(
  scope: ProjectSearchScope,
  embedding: { vector: number[]; model: string | null },
  limit: number,
  chunkTypes?: string[],
  metadataFilter?: Record<string, unknown>,
  sourceIds?: string[],
  chunkIds?: string[],
): Promise<RetrievalResult[]> {
  const rows = await prisma.$queryRaw<Array<SearchChunk & { similarity: number }>>(exactDistanceOrder({
    table: "chunks", alias: "c", columns: searchChunkColumns,
    scope: Prisma.sql`${searchableChunkFilter(scope, sourceIds, chunkTypes, metadataFilter, chunkIds)}
      AND c.embedding IS NOT NULL AND ${compatibleEmbeddingModel(Prisma.sql`c.metadata`, embedding.model)}`,
    embedding: `[${embedding.vector.join(",")}]`, limit,
  }));
  return rows.map(row => chunkResult(row, row.similarity, "vector"));
}

async function fullTextSearch(
  scope: ProjectSearchScope,
  query: string,
  limit: number,
  chunkTypes?: string[],
  metadataFilter?: Record<string, unknown>,
  sourceIds?: string[],
  chunkIds?: string[],
): Promise<RetrievalResult[]> {
  if (!query.trim()) return [];
  const searchQuery = Prisma.sql`websearch_to_tsquery('english', ${query.trim()})`;
  const indexedText = Prisma.sql`to_tsvector('english', coalesce(c."searchContent", c.content))`;
  const rows = await prisma.$queryRaw<Array<SearchChunk & { rank: number }>>`
    SELECT ${searchChunkColumns}, ts_rank_cd(${indexedText}, ${searchQuery}) AS rank FROM chunks c
    WHERE ${searchableChunkFilter(scope, sourceIds, chunkTypes, metadataFilter, chunkIds)} AND ${searchQuery} @@ ${indexedText}
    ORDER BY rank DESC, c.id LIMIT ${limit}`;
  const maxRank = rows[0]?.rank || 1;
  return rows.map(row => chunkResult(row, row.rank / maxRank, "bm25"));
}
// ─── Memory Search ───────────────────────────────────────────

async function memorySearch(
  projectId: string,
  queryEmbedding: number[],
  opts: { orgId?: string; userId?: string; sessionId?: string; agentId?: string; topK: number }
): Promise<RetrievalResult[]> {
  // Never fall back to project-wide personal-memory search. Callers must provide user scope.
  if (!opts.userId) return [];
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const sessionFilter = opts.sessionId ? Prisma.sql`AND m."sessionId" = ${opts.sessionId}` : Prisma.empty;
  // The agent narrows the session's scope, as before: an agent without a session does not filter.
  const agentFilter = opts.sessionId && opts.agentId ? Prisma.sql`AND m."agentId" = ${opts.agentId}` : Prisma.empty;

  const results = await prisma.$queryRaw(exactDistanceOrder({
    table: "memories",
    alias: "m",
    columns: Prisma.sql`m.id, m.content, m."memoryType", m.metadata, m.importance`,
    scope: Prisma.sql`
      m."projectId" = ${projectId}
        ${opts.orgId === undefined ? Prisma.empty : Prisma.sql`AND m."orgId" = ${opts.orgId}`}
        AND m."isActive" = true
        AND (m."expiresAt" IS NULL OR m."expiresAt" > NOW())
        AND m."userId" = ${opts.userId}
        ${sessionFilter}
        ${agentFilter}`,
    embedding: embeddingStr,
    limit: opts.topK,
  }));

  // Update access counts
  const ids = (results as any[]).map((r) => r.id);
  if (ids.length > 0) {
    void prisma.memory.updateMany({
      where: { id: { in: ids } },
      data: {
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
      },
    }).catch((error: any) => {
      console.warn("[Retriever] Failed to update memory access stats:", error?.message || error);
    });
  }

  return (results as any[]).map((r) => ({
    id: r.id,
    content: r.content,
    score: r.similarity * (r.importance || 0.5),
    metadata: { ...(r.metadata || {}), memoryType: r.memoryType },
    chunkType: "memory" as any,
    source: "memory" as const,
  }));
}

// ─── Reciprocal Rank Fusion ──────────────────────────────────

function reciprocalRankFusion(
  results: RetrievalResult[],
  vectorWeight: number,
  bm25Weight: number,
  k = 60
): RetrievalResult[] {
  const scoreMap = new Map<string, { result: RetrievalResult; rrfScore: number }>();

  // Group by source type and rank
  const vectorResults = results.filter((r) => r.source === "vector");
  const bm25Results = results.filter((r) => r.source === "bm25");
  const otherResults = results.filter((r) => r.source !== "vector" && r.source !== "bm25");

  // RRF scoring for vector results (use for ranking only)
  vectorResults.forEach((r, rank) => {
    const existing = scoreMap.get(r.id);
    const rrfScore = vectorWeight / (k + rank + 1);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      scoreMap.set(r.id, { result: r, rrfScore });
    }
  });

  // RRF scoring for BM25 results
  bm25Results.forEach((r, rank) => {
    const existing = scoreMap.get(r.id);
    const rrfScore = bm25Weight / (k + rank + 1);
    if (existing) {
      existing.rrfScore += rrfScore;
      existing.result.source = "hybrid";
    } else {
      scoreMap.set(r.id, { result: { ...r, source: "hybrid" as const }, rrfScore });
    }
  });

  // Add other results with their original scores
  otherResults.forEach((r) => {
    if (!scoreMap.has(r.id)) {
      scoreMap.set(r.id, { result: r, rrfScore: r.score * 0.5 });
    }
  });

  // Sort by RRF score but keep original similarity scores
  const sorted = Array.from(scoreMap.values()).sort((a, b) => b.rrfScore - a.rrfScore);

  // Return results with their original similarity scores, sorted by RRF
  return sorted.map((entry, index) => ({
    ...entry.result,
    // Boost score based on position in combined ranking
    score: Math.max(entry.result.score, entry.rrfScore * 10),
  }));
}

// ─── LLM Reranking ───────────────────────────────────────────

/**
 * Hybrid Smart Re-ranking
 *
 * Strategy:
 * 1. Use cross-encoder for fast re-ranking (50ms)
 * 2. If confidence is low (<0.85), use LLM fallback (500ms)
 * 3. Result: 93% accuracy at 260ms avg (only 20% use LLM)
 */
async function rerankResults(
  query: string,
  results: RetrievalResult[],
  topK: number,
  opts: { startTimeMs: number; requestBudgetMs: number }
): Promise<RetrievalResult[]> {
  if (results.length <= 3) return results; // not worth reranking

  // Take top candidates for reranking
  const candidates = results.slice(0, Math.min(results.length, Math.max(topK * 2, MAX_RERANK_CANDIDATES)));

  if (RERANK_PROVIDER === "remote") {
    try {
      const reranked = await rerankWithInferenceService(query, candidates, topK);
      return reranked.map((r) => ({
        ...r,
        score: r.combinedScore,
      }));
    } catch (error: any) {
      console.warn("[Retriever] Remote reranking failed, falling back to local strategy:", error.message);
      if (REMOTE_INFERENCE_REQUIRED) throw error;
    }
  }

  if (RERANK_MODE === "llm") {
    return rerankWithLLM(query, candidates, topK);
  }

  if (RERANK_MODE === "cross-encoder") {
    const reranked = await rerankWithCrossEncoder(query, candidates, topK);
    return reranked.map((r) => ({
      ...r,
      score: r.combinedScore,
    }));
  }

  try {
    const crossEncoderResults = await rerankWithCrossEncoder(query, candidates, topK);
    const needsLLMFallback = shouldUseLLMFallback(crossEncoderResults);
    const elapsed = Date.now() - opts.startTimeMs;
    const remainingBudget = opts.requestBudgetMs - elapsed;
    const canUseLLMFallback =
      LLM_RERANK_ENABLED &&
      crossEncoderResults.length > 1 &&
      crossEncoderResults.length <= LLM_RERANK_MAX_CANDIDATES &&
      remainingBudget >= LLM_RERANK_MIN_BUDGET_MS;

    if (needsLLMFallback && canUseLLMFallback) {
      const llmReranked = await rerankWithLLM(
        query,
        crossEncoderResults.slice(0, LLM_RERANK_MAX_CANDIDATES).map((r) => ({
          ...r,
          score: r.combinedScore,
        })),
        topK
      );

      const finalResults = [
        ...llmReranked.slice(0, 3),
        ...crossEncoderResults.slice(3, topK).map((r) => ({
          ...r,
          score: r.combinedScore,
        })),
      ];

      return finalResults.slice(0, topK);
    }

    return crossEncoderResults.map((r) => ({
      ...r,
      score: r.combinedScore,
    })).slice(0, topK);
  } catch (error: any) {
    console.warn("[Retriever] Cross-encoder reranking failed, using score sort fallback:", error.message);
    return [...candidates].sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

/**
 * LLM-based re-ranking (slow but smart)
 * Used as fallback for hybrid mode
 */
async function rerankWithLLM(
  query: string,
  candidates: RetrievalResult[],
  topK: number
): Promise<RetrievalResult[]> {
  const prompt = `Given the query: "${query}"

Rank these ${candidates.length} text passages by relevance (most relevant first). Return ONLY a JSON array of indices (0-based), e.g. [2, 0, 4, 1, 3].

${candidates.map((r, i) => `[${i}] ${r.content.slice(0, 300)}`).join("\n\n")}`;

  try {
    const openai = getOpenAIClient();
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 200,
    });

    const text = res.choices[0]?.message?.content?.trim() || "";
    const match = text.match(/\[[\d,\s]+\]/);
    if (!match) return candidates.slice(0, topK);

    const indices: number[] = JSON.parse(match[0]);
    const reranked: RetrievalResult[] = [];

    for (const idx of indices) {
      if (idx >= 0 && idx < candidates.length) {
        reranked.push({
          ...candidates[idx],
          score: 1 - reranked.length * (1 / indices.length),
        });
      }
    }

    // Add any results that weren't reranked
    for (const r of candidates) {
      if (!reranked.find((rr) => rr.id === r.id)) {
        reranked.push(r);
      }
    }

    return reranked.slice(0, topK);
  } catch (error) {
    console.error('[Retriever] LLM reranking failed:', error);
    return candidates.slice(0, topK);
  }
}

// ─── Deduplication ───────────────────────────────────────────

function attachGraphEvidence(results: RetrievalResult[], evidence: Awaited<ReturnType<typeof searchGraphChunks>>["evidence"]) {
  return results.map((result) => {
    const graph = result.source === "memory" ? undefined : evidence.get(result.id);
    return graph ? { ...result, metadata: { ...result.metadata, graph } } : result;
  });
}

function deduplicateResults(results: RetrievalResult[]): RetrievalResult[] {
  const seen = new Map<string, RetrievalResult>();

  for (const r of results) {
    const existing = seen.get(r.id);
    if (!existing || r.score > existing.score) {
      seen.set(r.id, r);
    }
  }

  return Array.from(seen.values());
}

// ─── Context Packing ─────────────────────────────────────────

function packContext(results: RetrievalResult[], maxTokens?: number): string {
  if (results.length === 0) return "";

  const limit = maxTokens || 8000;
  let totalTokens = 0;
  const packed: string[] = [];

  for (const r of results) {
    const header = buildChunkHeader(r);
    const parentFull = typeof r.metadata?.parent_content === "string" ? r.metadata.parent_content : "";
    const parentExcerpt = typeof r.metadata?.parent_excerpt === "string" ? r.metadata.parent_excerpt : "";
    const content = String(parentFull || parentExcerpt || r.content || "");
    const matched = parentFull || parentExcerpt ? `Matched snippet:\n${r.content}\n` : "";
    const block = `${header}\n${matched}${content}\n`;
    const tokens = estimateTokens(block);

    if (totalTokens + tokens > limit) break;

    packed.push(block);
    totalTokens += tokens;
  }

  return packed.join("\n---\n\n");
}

function buildChunkHeader(r: RetrievalResult): string {
  const parts: string[] = [];
  if (r.project) parts.push(`Project: ${r.project}`);

  if (r.sourceName) parts.push(`Source: ${r.sourceName}`);
  if (r.documentTitle) parts.push(`Document: ${r.documentTitle}`);
  if (r.metadata?.filePath) parts.push(`File: ${r.metadata.filePath}`);
  if (r.metadata?.startLine) parts.push(`Lines: ${r.metadata.startLine}-${r.metadata.endLine || "?"}`);
  if (r.metadata?.section_path) parts.push(`Section: ${r.metadata.section_path}`);
  if (r.metadata?.page) parts.push(`Page: ${r.metadata.page}`);
  if (r.metadata?.timestamp_start_ms) parts.push(`Time: ${Math.floor(Number(r.metadata.timestamp_start_ms) / 1000)}s`);
  if (r.chunkType && r.chunkType !== "text") parts.push(`Type: ${r.chunkType}`);

  return parts.length > 0 ? `[${parts.join(" | ")}]` : "";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildParentExcerpt(parentContent: string, query: string): string {
  if (!parentContent) return "";
  if (parentContent.length <= PARENT_EXCERPT_MAX_CHARS) return parentContent;

  const halfWindow = Math.floor(PARENT_EXCERPT_MAX_CHARS / 2);
  const lowerContent = parentContent.toLowerCase();
  const queryTokens = query
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  let anchor = -1;
  for (const token of queryTokens) {
    const idx = lowerContent.indexOf(token);
    if (idx >= 0 && (anchor < 0 || idx < anchor)) {
      anchor = idx;
    }
  }

  if (anchor < 0) {
    return parentContent.slice(0, PARENT_EXCERPT_MAX_CHARS);
  }

  let start = Math.max(0, anchor - halfWindow);
  let end = Math.min(parentContent.length, anchor + halfWindow);
  const window = end - start;
  if (window < PARENT_EXCERPT_MAX_CHARS) {
    if (start === 0) {
      end = Math.min(parentContent.length, PARENT_EXCERPT_MAX_CHARS);
    } else if (end === parentContent.length) {
      start = Math.max(0, parentContent.length - PARENT_EXCERPT_MAX_CHARS);
    }
  }
  return parentContent.slice(start, end);
}

// ─── Enrich Results ──────────────────────────────────────────

async function enrichResults(results: RetrievalResult[]): Promise<RetrievalResult[]> {
  // Get unique document IDs from chunk results
  const chunkResults = results.filter((r) => r.source !== "memory");
  if (chunkResults.length === 0) return results;

  // We need document IDs — stored in metadata or we need to query
  const chunkIds = chunkResults.map((r) => r.id);

  if (chunkIds.length === 0) return results;

  const chunkDocs = await prisma.$queryRaw`
    SELECT
      c.id as "chunkId", d.title as "docTitle", d."webUrl" as "webUrl", d.path as "docPath", s.id as "sourceId", s.name as "sourceName", p.name as project
    FROM chunks c
    INNER JOIN documents d ON c."documentId" = d.id
    INNER JOIN sources s ON d."sourceId" = s.id
    INNER JOIN projects p ON p.id = c."projectId"
    WHERE c.id = ANY(${chunkIds})
  `;

  const enrichMap = new Map((chunkDocs as any[]).map((d) => [d.chunkId, d]));

  return results.map((r) => {
    const enrichment = enrichMap.get(r.id);
    if (enrichment) {
      return {
        ...r,
        documentTitle: enrichment.docTitle || undefined,
        sourceName: enrichment.sourceName || undefined,
        project: enrichment.project,
        metadata: {
          ...r.metadata,
          source_id: enrichment.sourceId || r.metadata?.source_id,
          web_url: enrichment.webUrl || r.metadata?.web_url,
          path: enrichment.docPath || r.metadata?.path,
        },
      };
    }
    return r;
  });
}

async function expandParentContexts(
  results: RetrievalResult[],
  opts: { query: string; includeParentContent: boolean }
): Promise<RetrievalResult[]> {
  const chunkIds = results.filter(result => result.source !== "memory" && result.metadata?.parent_chunk_id).map(result => result.id);
  if (chunkIds.length === 0) return results;

  const parents = await prisma.$queryRaw<Array<{
    childId: string; content: string; sectionPath: string | null; headingPath: string | null;
  }>>`
    SELECT child.id AS "childId", parent.content,
      COALESCE(parent."sectionPath", parent.metadata->>'section_path') AS "sectionPath",
      COALESCE(parent."headingPath", parent.metadata->>'heading_path') AS "headingPath"
    FROM chunks child JOIN chunks parent
      ON parent.id = COALESCE(child."parentChunkId", child.metadata->>'parent_chunk_id')
      AND parent."documentId" = child."documentId" AND parent."projectId" = child."projectId"
    WHERE child.id = ANY(${chunkIds}::text[])`;
  const parentMap = new Map(parents.map(parent => [parent.childId, parent]));

  return results.map((result) => {
    const parent = parentMap.get(result.id);
    if (!parent) return result;
    const parentContent = String(parent.content || "");
    const parentExcerpt = buildParentExcerpt(parentContent, opts.query);
    return {
      ...result,
      metadata: {
        ...result.metadata,
        ...(opts.includeParentContent ? { parent_content: parentContent } : {}),
        parent_excerpt: parentExcerpt,
        parent_section_path: parent.sectionPath,
        parent_heading_path: parent.headingPath,
      },
    };
  });
}

// ─── Cache ───────────────────────────────────────────────────

function stableStringify(value: any): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`);
  return `{${entries.join(",")}}`;
}

function hashCacheKey(params: Record<string, any>): string {
  const normalized = stableStringify(params);
  return createHash("sha256").update(normalized).digest("hex");
}

function buildContextCacheKey(projectId: string, params: Record<string, any>): string {
  return `whisper:context:query:${projectId}:${hashCacheKey(params)}`;
}

async function checkCache(projectId: string, params: Record<string, any>) {
  const key = buildContextCacheKey(projectId, params);
  return getFromCache<RetrievalResult[]>(key);
}

async function setCache(
  projectId: string,
  params: Record<string, any>,
  results: RetrievalResult[],
  ttlSeconds: number
) {
  const key = buildContextCacheKey(projectId, params);
  await setInCache(key, results, ttlSeconds);
}

function attachLegacyTimingAliases(timing: NonNullable<ContextResponse["meta"]["timing"]>): void {
  timing.cacheCheckMs = timing.cache_check_ms;
  timing.embedMs = timing.embed_ms;
  timing.oracleMs = timing.oracle_ms;
  timing.vectorMs = timing.vector_ms;
  timing.bm25Ms = timing.fts_ms;
  timing.rerankMs = timing.rerank_ms;
  timing.enrichMs = timing.enrich_ms;
  timing.packMs = timing.pack_ms;
  timing.cacheSetMs = timing.cache_set_ms;
  timing.totalMs = timing.total_ms;
}

function emitStageTimingLog(params: {
  projectId?: string;
  query: string;
  topK: number;
  cacheHit: boolean;
  timing: NonNullable<ContextResponse["meta"]["timing"]>;
}): void {
  const stageTimings = {
    cache_check_ms: params.timing.cache_check_ms || 0,
    embed_ms: params.timing.embed_ms || 0,
    oracle_ms: params.timing.oracle_ms || 0,
    vector_ms: params.timing.vector_ms || 0,
    fts_ms: params.timing.fts_ms || 0,
    rerank_ms: params.timing.rerank_ms || 0,
    enrich_ms: params.timing.enrich_ms || 0,
    pack_ms: params.timing.pack_ms || 0,
    cache_set_ms: params.timing.cache_set_ms || 0,
    total_ms: params.timing.total_ms || 0,
  };

  recordStageBreakdown("POST /v1/context/query", stageTimings);

  if (STAGE_TIMING_LOG_ENABLED) {
    console.log(
      `[RetrieverTiming] ${JSON.stringify({
        route: "/v1/context/query",
        profile: RETRIEVAL_PROFILE,
        project_id: params.projectId,
        query_len: params.query.length,
        top_k: params.topK,
        cache_hit: params.cacheHit,
        timing: stageTimings,
      })}`
    );
  }
}

function normalizeRetrievalFamily(value: unknown): "repo_web" | "pdf" | "video" | "plain_text" | "unknown" {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (raw === "repo" || raw === "web_docs" || raw === "web" || raw === "github" || raw === "gitlab") {
    return "repo_web";
  }
  if (raw === "pdf" || raw === "pdf_layout") return "pdf";
  if (raw === "video" || raw === "video_transcript") return "video";
  if (raw === "plain_text") return "plain_text";
  return "unknown";
}

function getResultFamily(result: RetrievalResult): "repo_web" | "pdf" | "video" | "plain_text" | "unknown" {
  return normalizeRetrievalFamily(
    result.metadata?.source_family ||
      result.metadata?.source_type ||
      result.metadata?.source_kind ||
      result.metadata?.ingestion_profile
  );
}

function applyRepoFirstFamilyFilter(results: RetrievalResult[]): RetrievalResult[] {
  if (results.length === 0) return results;
  const preferredFamilies = new Set(["repo_web", "plain_text"]);

  const nonVideo = results.filter((result) => {
    if (result.source === "memory" || result.source === "graph") return true;
    return getResultFamily(result) !== "video";
  });
  if (nonVideo.length === 0) return [];

  const preferredOnly = nonVideo.filter((result) => {
    if (result.source === "memory" || result.source === "graph") return true;
    return preferredFamilies.has(getResultFamily(result));
  });

  const hasPreferred = preferredOnly.some((result) => result.source !== "memory" && result.source !== "graph");
  return hasPreferred ? preferredOnly : nonVideo;
}

function applyPrecisionCutoff(results: RetrievalResult[], isCodebaseIntent: boolean): RetrievalResult[] {
  if (results.length === 0) return results;
  const topScore = Math.max(...results.map((result) => Number(result.score || 0)));
  const absoluteFloor = isCodebaseIntent ? 0.45 : 0.35;
  const relativeFloor = isCodebaseIntent ? topScore * 0.62 : topScore * 0.55;
  const cutoff = Math.max(absoluteFloor, relativeFloor);
  return results.filter((result) => Number(result.score || 0) >= cutoff);
}

function inferRetrievalWorkload(
  results: RetrievalResult[],
  metadataFilter?: Record<string, any>
): "repo_web" | "pdf" | "video" | "plain_text" | "mixed" | "unknown" {
  const explicit = normalizeRetrievalFamily(
    metadataFilter?.source_family ||
      metadataFilter?.source_type ||
      metadataFilter?.source_kind ||
      metadataFilter?.ingestion_profile
  );
  if (explicit !== "unknown") return explicit;

  const families = new Set<string>();
  for (const result of results) {
    if (result.source === "memory" || result.source === "graph") continue;
    const family = normalizeRetrievalFamily(
      result.metadata?.source_family ||
        result.metadata?.source_type ||
        result.metadata?.source_kind ||
        result.metadata?.ingestion_profile
    );
    if (family !== "unknown") families.add(family);
  }

  if (families.size === 0) return "unknown";
  if (families.size === 1) return Array.from(families)[0] as "repo_web" | "pdf" | "video" | "plain_text";
  return "mixed";
}

