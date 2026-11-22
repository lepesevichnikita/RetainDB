/**
 * Persistence for the repository index: attempts, parts and published generations.
 *
 * The publication fence itself lives in receipt.ts. This module loads the row shapes
 * those rules need, asks them, and applies the answer in one transaction; it never
 * re-implements scope identity, digest identity, revocation or the base compare-and-swap.
 *
 * A publication is two phases, because the work that materialises a tree does not fit in one
 * transaction and must not hold the generation's row lock while it runs: `stageAttempt` reads,
 * chunks and embeds the tree in bounded transactions that write rows nobody can see yet, and
 * `finalizeAttempt` promotes them in the one short transaction that fences the attempt, writes the
 * path rows and moves the scope's active generation. `finalizeAttempt` stages on its own when the
 * caller does not hand it a stage, so a connector still makes one call.
 *
 * Configuration: REPO_INDEX_CURSOR_SECRET signs and verifies the manifest cursors this module
 * issues. A production process refuses to load without a non-empty value, because the fallback
 * below is published in this file and would let a caller mint its own cursors; anywhere else the
 * local value keeps runs working without a secret.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "../../db/index.js";
// The canonical payload hash is shared with request idempotency: one canonicalisation,
// one digest algorithm, so a part's stored hash and an HTTP replay hash never disagree.
import { hashIdempotencyPayload } from "../../api/idempotency.js";
import { clearCacheByPattern } from "../cache.js";
import {
  PROMOTION_OUTCOME,
  baseRefusal,
  isScopeReadable,
  promoteAttempt,
  scopeRefusal,
  type AttemptReceipt,
  type Manifest,
  type ManifestEntry,
  type PromotionOutcome,
  type ScopeState,
  type ScopeStatus,
} from "./receipt.js";
import {
  discardStaged,
  planMaterialisation,
  promoteStaged,
  retireUnlistedPaths,
  scopeSourceName,
  stageBatch,
  sweepStaleStages,
  type ContentReader,
  type Embedder,
  type MaterialiseOutcome,
  type PreparedPath,
  type StagedBatch,
} from "./materialise.js";

// The Prisma client generated for this worktree can predate the repo-index models
// (`prisma generate` is not run here), so the database handle is narrowed once, in
// this constant, and every domain shape below is typed explicitly instead.
const db = prisma as any;

/** The transaction handle these queries run on; it carries the same narrowing as `db`. */
type Transaction = any;

/** Environment variable that signs manifest cursors; documented in the module comment. */
export const CURSOR_SECRET_VARIABLE = "REPO_INDEX_CURSOR_SECRET";

/** The secret a process without one falls back to: local runs only, never a deployment. */
const LOCAL_CURSOR_SECRET = "repo-index-local-cursor-secret";

/**
 * The secret this process signs and verifies cursors with. An empty value is not a secret, and a
 * production process has no fallback it could safely use: LOCAL_CURSOR_SECRET is part of this
 * file, so falling back to it would let any caller mint a cursor this store accepts.
 */
export function resolveCursorSecret(environment: Record<string, string | undefined>): string {
  const configured = environment[CURSOR_SECRET_VARIABLE]?.trim();
  if (configured) return configured;
  if (environment.NODE_ENV === "production") {
    throw new Error(`${CURSOR_SECRET_VARIABLE} must be a non-empty secret in production`);
  }
  return LOCAL_CURSOR_SECRET;
}

/** Resolved once, as the process loads: a deployment without a secret fails here, not per request. */
const CURSOR_SECRET = resolveCursorSecret(process.env);

/**
 * A finalize writes one generation of up to 10,000 entries in a handful of statements, so it no
 * longer fits Prisma's default 5s budget; the long wait keeps a queued writer from failing early.
 */
const TRANSACTION = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * `maxWait` bounds only how long a transaction may queue for a connection; the wait for a row lock
 * belongs to `timeout`. Capping the lock wait below that budget makes contention answer as a
 * retryable refusal instead of holding a request for 30s and then failing as an unhandled 500.
 */
const LOCK_TIMEOUT_MS = 5_000;

/** Entries per write in finalize: 500 rows stay far below PostgreSQL's parameter limit. */
const PATH_BATCH = 500;

/**
 * Paths one staging transaction carries. Staging runs outside the sealing transaction, so its
 * batches are bounded by wall-clock instead of by what must be atomic: one batch is one
 * transaction, and a batch of this size is far below the 30s budget even on a slow database.
 */
const STAGE_PATHS = 20;

/**
 * Chunk rows one staging transaction carries. A single file can hold thousands of chunks, so a
 * batch closes on either bound; the file that crossed it is written alone rather than with a
 * neighbour that would make one transaction carry two files' work.
 */
const STAGE_CHUNKS = 400;


export const STORE_CODE = {
  OK: "OK",
  SCOPE_NOT_FOUND: "SCOPE_NOT_FOUND",
  SCOPE_NOT_ACTIVE: "SCOPE_NOT_ACTIVE",
  ATTEMPT_OPEN: "ATTEMPT_OPEN",
  ATTEMPT_REPLAYED: "ATTEMPT_REPLAYED",
  ATTEMPT_CONFLICT: "ATTEMPT_CONFLICT",
  ATTEMPT_NOT_FOUND: "ATTEMPT_NOT_FOUND",
  ATTEMPT_FENCED: "ATTEMPT_FENCED",
  PART_ACCEPTED: "PART_ACCEPTED",
  PART_REPLAYED: "PART_REPLAYED",
  PART_CONFLICT: "PART_CONFLICT",
  PART_OUT_OF_RANGE: "PART_OUT_OF_RANGE",
  PARTS_MISSING: "PARTS_MISSING",
  STAGED: "STAGED",
  PUBLISHED: "PUBLISHED",
  ABANDONED: "ABANDONED",
  ALREADY_ABANDONED: "ALREADY_ABANDONED",
  CANNOT_ABANDON_PUBLISHED: "CANNOT_ABANDON_PUBLISHED",
  RECEIPT_NOT_PUBLISHED: "RECEIPT_NOT_PUBLISHED",
  NO_GENERATION_PUBLISHED: "NO_GENERATION_PUBLISHED",
  GENERATION_EXPIRED: "GENERATION_EXPIRED",
  INVALID_CURSOR: "INVALID_CURSOR",
  UNDECLARED_DROP: "UNDECLARED_DROP",
  LOCK_TIMEOUT: "LOCK_TIMEOUT",
} as const;

export type StoreCode = (typeof STORE_CODE)[keyof typeof STORE_CODE] | PromotionOutcome;

/** A row of repo_index_scopes, limited to the columns the fence and materialisation read. */
interface ScopeRow {
  id: string;
  state: string;
  activeGeneration: number;
  projectId: string;
  orgId: string;
}

/** A row of repo_index_generations. */
interface GenerationRow {
  id: string;
  scopeId: string;
  attemptId: string;
  baseGeneration: number;
  generation: number;
  revision: string;
  manifestDigest: string;
  partCount: number;
  status: string;
  receiptDigest: string | null;
  failureCode: string | null;
  publishedAt: Date | null;
}

/** A row of repo_index_parts. */
interface PartRow {
  partNo: number;
  requestHash: string;
  upsertCount: number;
  tombstoneCount: number;
  tombstonePaths: string[];
  status: string;
}

/** The paths one attempt uploads in one part; the counts are what the receipt records. */
export interface PartPayload {
  upserts: string[];
  tombstones: string[];
}

/** One path of a manifest, with the vector receipt.ts must find usable. */
export interface IndexedPath extends ManifestEntry {
  digest: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  chunkId?: string | null;
}

/** The complete manifest one attempt publishes. */
export interface AttemptManifest {
  digest: string;
  dimensions: number;
  entries: IndexedPath[];
}

export interface OpenAttemptInput {
  scopeId: string;
  attemptId: string;
  baseGeneration: number;
  revision: number;
  manifestDigest: string;
  partCount: number;
}

export interface OpenAttemptResult {
  code: StoreCode;
  generationId?: string;
  generation?: number;
}

export interface PutPartInput {
  scopeId: string;
  attemptId: string;
  partNo: number;
  part: PartPayload;
}

export interface PutPartResult {
  code: StoreCode;
  partNo: number;
  upsertCount?: number;
  tombstoneCount?: number;
  status?: string;
}

export interface FinalizeInput {
  scopeId: string;
  attemptId: string;
  requiredPaths: string[];
  manifest: AttemptManifest;
  /**
   * Reads the content of one manifest path so this publication can materialise the generation into
   * searchable chunks. A caller that omits it publishes path rows only, which is what this store did
   * before materialisation existed; a reader that throws refuses the publication (see publish()).
   */
  readContent?: ContentReader;
  /**
   * Turns the text of each chunk into its vector. A caller that omits it gets the pipeline's own
   * embedder (engine/embeddings.ts), which is what a deployment runs; it exists so a caller can
   * supply its own, and publish() forwards it by name - an option this interface did not declare
   * was silently dropped, which is how a test embedder could look unused.
   */
  embed?: Embedder;
  /**
   * The materialisation an earlier `stageAttempt` staged for this attempt. Finalize stages its own
   * when the caller names none, which is what a connector does; naming one is how a caller stages,
   * inspects what readers see in between, and only then promotes.
   */
  staged?: StagedPublication;
}

/**
 * The materialisation one stage wrote, ready to be promoted. It names the generation and the stage
 * that own the rows - only those become visible - and the chunk every manifest path anchors, so the
 * promotion can write the path rows without reading anything.
 */
export interface StagedPublication {
  scopeId: string;
  attemptId: string;
  generationId: string;
  stageId: string;
  /** The scope's source the rows were staged into, or null when nothing had to be written. */
  sourceId: string | null;
  /** The paths this stage wrote documents and chunks for; empty when every path was reused. */
  stagedPaths: string[];
  /** The chunk each manifest path anchors, reused from the served generation or written by this stage. */
  anchors: ReadonlyMap<string, string>;
  /** What this stage wrote, in the form a publication reports. */
  materialise: MaterialiseOutcome;
}

export interface StageInput {
  scopeId: string;
  attemptId: string;
  manifest: AttemptManifest;
  readContent: ContentReader;
  embed?: Embedder;
}

export interface StageResult {
  code: StoreCode;
  generationId?: string;
  missingParts?: number[];
  staged?: StagedPublication;
}

export interface FinalizeResult {
  code: StoreCode;
  generationId?: string;
  generation?: number;
  receiptDigest?: string;
  missingParts?: number[];
  undeclaredDrops?: string[];
  /**
   * What this call materialised, when it had a reader to materialise with: reused paths, created
   * paths and chunk rows written. Absent for a metadata-only publication, so a caller can report
   * the chunks it really wrote instead of a number it assumed.
   */
  materialise?: MaterialiseOutcome;
}

export interface AbandonResult {
  code: StoreCode;
  generationId?: string;
}

/** A published receipt: what the caller can point at after a promotion. */
export interface AttemptReceiptView {
  scopeId: string;
  attemptId: string;
  generation: number;
  revision: number;
  manifestDigest: string;
  receiptDigest: string;
  publishedAt: Date;
}

export interface ReadReceiptResult {
  code: StoreCode;
  receipt?: AttemptReceiptView;
}

/** One path of a manifest page; tombstones never appear here. */
export interface ManifestPath {
  path: string;
  digest: string;
  lineStart: number | null;
  lineEnd: number | null;
  chunkId: string | null;
}

export interface ManifestPage {
  code: StoreCode;
  generation?: number;
  entries?: ManifestPath[];
  nextCursor?: string | null;
}

/**
 * Opens an attempt against the generation the caller observed. The declared base is
 * kept as a number so the fence can compare it with the scope's active generation at
 * publish time, whatever has happened to the scope in between.
 */
export async function openAttempt(input: OpenAttemptInput): Promise<OpenAttemptResult> {
  const scope = (await db.repoIndexScope.findUnique({ where: { id: input.scopeId } })) as ScopeRow | null;
  if (!scope) return { code: STORE_CODE.SCOPE_NOT_FOUND };
  if (!isScopeReadable(scopeState(scope))) return { code: scopeRefusalCode(scope.state) };
  const existing = await loadGeneration(input.scopeId, input.attemptId);
  if (existing) return replayAttempt(existing, input);
  return createAttempt(input);
}

async function createAttempt(input: OpenAttemptInput): Promise<OpenAttemptResult> {
  // Two attempts opening at once can allocate the same generation number. The loser retries once on
  // the number it now sees, instead of being told the attempt it just created already exists.
  for (let allocation = 1; allocation <= 2; allocation++) {
    const generation = await nextGenerationNumber(input.scopeId);
    try {
      const row = (await db.repoIndexGeneration.create({
        data: {
          scopeId: input.scopeId,
          attemptId: input.attemptId,
          baseGeneration: input.baseGeneration,
          generation,
          revision: String(input.revision),
          manifestDigest: input.manifestDigest,
          partCount: input.partCount,
          status: "open",
        },
      })) as GenerationRow;
      return { code: STORE_CODE.ATTEMPT_OPEN, generationId: row.id, generation: row.generation };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The same attempt id landed first: answer with the row that exists rather than a conflict.
      const winner = await loadGeneration(input.scopeId, input.attemptId);
      if (winner) return replayAttempt(winner, input);
    }
  }
  return { code: STORE_CODE.ATTEMPT_CONFLICT };
}

function replayAttempt(existing: GenerationRow, input: OpenAttemptInput): OpenAttemptResult {
  const sameDeclaration =
    existing.baseGeneration === input.baseGeneration &&
    existing.manifestDigest === input.manifestDigest &&
    existing.partCount === input.partCount &&
    existing.revision === String(input.revision);
  if (!sameDeclaration) return { code: STORE_CODE.ATTEMPT_CONFLICT, generationId: existing.id };
  return { code: STORE_CODE.ATTEMPT_REPLAYED, generationId: existing.id, generation: existing.generation };
}

async function nextGenerationNumber(scopeId: string): Promise<number> {
  const highest = await db.repoIndexGeneration.aggregate({ where: { scopeId }, _max: { generation: true } });
  return (highest._max.generation ?? 0) + 1;
}

/**
 * Stores one part of an attempt. The part number is the addressing key and the
 * canonical payload hash is the identity, so the same payload answers with the stored
 * outcome and a different payload is refused instead of overwriting it.
 *
 * The attempt row is locked for the whole write: publishing and abandoning change the status
 * this decision reads, so accepting a part has to either see their outcome or wait for it.
 */
export async function putPart(input: PutPartInput): Promise<PutPartResult> {
  try {
    return await prisma.$transaction((tx: Transaction) => storePart(tx, input), TRANSACTION);
  } catch (error) {
    if (isLockTimeout(error)) return { code: STORE_CODE.LOCK_TIMEOUT, partNo: input.partNo };
    throw error;
  }
}

async function storePart(tx: Transaction, input: PutPartInput): Promise<PutPartResult> {
  await boundLockWaits(tx);
  const attempt = await lockGeneration(tx, input.scopeId, input.attemptId);
  if (!attempt) return { code: STORE_CODE.ATTEMPT_NOT_FOUND, partNo: input.partNo };
  if (input.partNo < 1 || input.partNo > attempt.partCount) return { code: STORE_CODE.PART_OUT_OF_RANGE, partNo: input.partNo };

  const requestHash = hashIdempotencyPayload(input.part);
  // A stored part answers from its own row whatever happened to the attempt afterwards: a replay
  // is not a new write, so publishing that part must not turn its replay into a refusal.
  const stored = await loadPart(attempt.id, input.partNo, tx);
  if (stored) return answerStoredPart(stored, requestHash);
  if (attempt.status !== "open") return { code: STORE_CODE.ATTEMPT_FENCED, partNo: input.partNo };
  const refusal = await newPartRefusal(tx, input.scopeId);
  if (refusal) return { code: refusal, partNo: input.partNo };
  return acceptPart(tx, attempt.id, input, requestHash);
}

/**
 * The refusal a new part carries when the scope itself accepts none, or null when it may take one.
 * openAttempt and the publish CAS already read this state; without the same read here an in-process
 * caller could add parts to a paused or withdrawn scope. The scope row is read, not locked: a pause
 * that commits after this read is still caught by the publication CAS, which compares the state in
 * the same transaction that seals the generation.
 */
async function newPartRefusal(tx: Transaction, scopeId: string): Promise<StoreCode | null> {
  const scope = (await tx.repoIndexScope.findUnique({ where: { id: scopeId } })) as ScopeRow | null;
  if (!scope) return STORE_CODE.SCOPE_NOT_FOUND;
  return isScopeReadable(scopeState(scope)) ? null : scopeRefusalCode(scope.state);
}

async function acceptPart(tx: Transaction, generationId: string, input: PutPartInput, requestHash: string): Promise<PutPartResult> {
  try {
    const row = (await tx.repoIndexPart.create({
      data: {
        generationId,
        partNo: input.partNo,
        requestHash,
        upsertCount: input.part.upserts.length,
        tombstoneCount: input.part.tombstones.length,
        // The paths, not a count: the publication guard has to match them against the paths a
        // manifest drops, and two ghost tombstones must not pay for erasing two real ones.
        tombstonePaths: input.part.tombstones,
        status: "accepted",
      },
    })) as PartRow;
    return { code: STORE_CODE.PART_ACCEPTED, partNo: input.partNo, ...partOutcome(row) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another writer stored this part number first; answer from its row.
    const winner = await loadPart(generationId, input.partNo, tx);
    return winner ? answerStoredPart(winner, requestHash) : { code: STORE_CODE.PART_CONFLICT, partNo: input.partNo };
  }
}

function answerStoredPart(stored: PartRow, requestHash: string): PutPartResult {
  if (stored.requestHash !== requestHash) return { code: STORE_CODE.PART_CONFLICT, partNo: stored.partNo };
  return { code: STORE_CODE.PART_REPLAYED, partNo: stored.partNo, ...partOutcome(stored) };
}

function partOutcome(row: PartRow): Omit<PutPartResult, "code" | "partNo"> {
  return { upsertCount: row.upsertCount, tombstoneCount: row.tombstoneCount, status: row.status };
}

/**
 * The cached search answers of one project, cleared because what they describe changed.
 *
 * A search answer is cached per project with nothing in its key that names the generation or the
 * content revision it was computed from (engine/retriever.ts keys context answers
 * `query:<projectId>:<hash>`, engine/memory/search.ts keys memory answers
 * `search:<projectId>:<user>:<scope>:<query>`). Both live under the cache layer's single
 * `whisper:context:` key prefix, so one pattern per family drops every answer the project had.
 *
 * Clearing by project rather than by query is deliberate: the answers a publication invalidates
 * are exactly the ones that ranked the tree it replaced, and their keys carry the query, not the
 * rows. A generation in the key would leave every entry written before it live for its full TTL.
 */
export async function invalidateProjectAnswers(projectId: string): Promise<void> {
  await Promise.all([clearCacheByPattern(`query:${projectId}:`), clearCacheByPattern(`search:${projectId}:`)]);
}

/**
 * Fences the publication's caches after it commits. Read outside the transaction, because a clear
 * that ran before the commit could be refilled by a concurrent search from the tree being replaced,
 * and an answer cached then would outlive the commit by its full TTL.
 */
async function invalidatePublishedProject(scopeId: string, result: FinalizeResult): Promise<void> {
  if (result.code !== STORE_CODE.PUBLISHED) return;
  const scope = (await db.repoIndexScope.findUnique({ where: { id: scopeId }, select: { projectId: true } })) as
    | { projectId: string }
    | null;
  if (scope) await invalidateProjectAnswers(scope.projectId);
}

/**
 * Stages the materialisation of one open attempt: reads, chunks and embeds what the generation must
 * write, and stores it in bounded batches, each its own transaction. Nothing it writes is visible -
 * a staged document carries `deletedAt`, which every query that returns a chunk filters on - so this
 * runs before the fence, outside the transaction that publishes, and a refused or abandoned attempt
 * leaves the generation readers see untouched.
 *
 * The refusals a plan raises (unreadable content, an unusable vector, the chunk ceiling) are thrown
 * before the first row is written; the refusals an attempt raises are answered as codes, because the
 * fence will answer them again under its row lock.
 *
 * A declared base the scope has already left is answered as a code before the plan is made at all:
 * nothing this stage could write would ever be sealed, so nothing is read.
 */
export async function stageAttempt(input: StageInput): Promise<StageResult> {
  const scope = (await db.repoIndexScope.findUnique({ where: { id: input.scopeId } })) as ScopeRow | null;
  if (!scope) return { code: STORE_CODE.SCOPE_NOT_FOUND };
  if (!isScopeReadable(scopeState(scope))) return { code: scopeRefusalCode(scope.state) };
  const attempt = await loadGeneration(input.scopeId, input.attemptId);
  if (!attempt) return { code: STORE_CODE.ATTEMPT_NOT_FOUND };
  if (attempt.status !== "open") return { code: STORE_CODE.ATTEMPT_FENCED, generationId: attempt.id };
  // The seal compares the declared base with the active generation, so an attempt whose base has
  // already moved can never publish. Asking here costs one read of the scope row - the same row
  // read above, in the same order - and saves the whole tree: reading it, chunking it, embedding
  // it and writing every chunk of it, all of which the fence would answer SUPERSEDED_BASE to and
  // throw away. The seal keeps its own comparison as the authority: a publication can commit
  // between this read and that one, and only the compare inside the sealing transaction sees it.
  const superseded = baseRefusal(scopeState(scope), attemptReceipt(attempt));
  if (superseded) return { code: superseded, generationId: attempt.id };
  const missingParts = await missingPartNumbers(db, attempt);
  if (missingParts.length > 0) return { code: STORE_CODE.PARTS_MISSING, generationId: attempt.id, missingParts };

  const plan = await planMaterialisation(db, {
    scopeId: input.scopeId,
    projectId: scope.projectId,
    paths: input.manifest.entries.map((entry) => ({ path: entry.path, digest: entry.digest })),
    readContent: input.readContent,
    embed: input.embed,
  });
  const stageId = randomUUID();
  const stagedAt = new Date();
  const anchors = new Map<string, string>(plan.reuse.map((entry) => [entry.path, entry.chunkIds[0]]));
  let sourceId = plan.sourceId;
  for (const paths of stageBatches(plan.pending)) {
    const batch = (await prisma.$transaction(
      (tx: Transaction) =>
        stageBatch(tx, {
          scopeId: input.scopeId,
          projectId: scope.projectId,
          orgId: scope.orgId,
          generationId: attempt.id,
          stageId,
          stagedAt,
          paths,
        }),
      TRANSACTION,
    )) as StagedBatch;
    sourceId = batch.sourceId;
    for (const anchor of batch.anchors) anchors.set(anchor.path, anchor.chunkId);
  }
  return {
    code: STORE_CODE.STAGED,
    generationId: attempt.id,
    staged: {
      scopeId: input.scopeId,
      attemptId: input.attemptId,
      generationId: attempt.id,
      stageId,
      sourceId,
      stagedPaths: plan.pending.map((entry) => entry.path),
      anchors,
      materialise: {
        reused: plan.reuse.length,
        created: plan.pending.length,
        chunks: plan.pending.reduce((total, entry) => total + entry.chunks.length, 0),
      },
    },
  };
}

/**
 * Splits a plan's pending paths into the batches staging writes, one transaction each. A batch
 * closes on either bound, so one large file still gets a transaction of its own instead of sharing
 * one with everything before it.
 */
function* stageBatches(pending: readonly PreparedPath[]): Generator<PreparedPath[]> {
  let batch: PreparedPath[] = [];
  let chunks = 0;
  for (const entry of pending) {
    batch.push(entry);
    chunks += entry.chunks.length;
    if (batch.length < STAGE_PATHS && chunks < STAGE_CHUNKS) continue;
    yield batch;
    batch = [];
    chunks = 0;
  }
  if (batch.length > 0) yield batch;
}

/**
 * Publishes an attempt: every declared part must be present, then the fence decides in
 * one transaction that either writes the active generation, the path rows and the
 * receipt, or writes nothing but the attempt's failure code.
 *
 * The attempt row is locked first, so an abandon that read the same status cannot commit
 * between the fence's decision and the seal: one of the two writes sees the other's outcome.
 *
 * The materialisation is staged before this call and only made visible here: the transaction that
 * publishes does the fence, the path rows, the generation bump and the flip that turns the staged
 * rows into the index, and nothing that reads a tree.
 */
export async function finalizeAttempt(input: FinalizeInput): Promise<FinalizeResult> {
  const staging = await stagedFor(input);
  // The scope refused the stage this publication needs. The answer is the scope's own code, decided
  // where the scope was found unreadable; the seal's transaction is not opened for it, because a
  // scope that may not be read has nothing to publish, and the attempt is left as the stage found it
  // - a refusal is not a fence, so a resumed scope can still publish it.
  if (staging.refusal) return staging.refusal;
  const staged = staging.staged;
  try {
    const result = await prisma.$transaction((tx: Transaction) => publish(tx, input, staged), TRANSACTION);
    await invalidatePublishedProject(input.scopeId, result);
    // A stage that did not become the publication is dropped once no transaction holds its rows.
    // The rows were never visible, so this only decides whether they linger.
    await discardUnpublishedStage(staged);
    return result;
  } catch (error) {
    // The seal found the attempt no longer open. Its transaction rolls back with the throw, so a
    // fenced attempt never leaves a bumped generation, new paths or a half-written receipt behind.
    if (error instanceof FencedAttempt) {
      await discardUnpublishedStage(staged);
      return { code: STORE_CODE.ATTEMPT_FENCED, generationId: error.generationId };
    }
    // A transaction that queued too long for a row lock is contention, not a broken request.
    if (isLockTimeout(error)) {
      await discardUnpublishedStage(staged);
      return { code: STORE_CODE.LOCK_TIMEOUT };
    }
    throw error;
  }
}

/**
 * The materialisation this call promotes: the one the caller staged, a fresh stage of its own, or
 * the refusal that fresh stage answered.
 *
 * A stage refuses before it writes anything, so a scope refusal arrives with nothing to discard and
 * nothing to seal; it is handed back as this call's answer instead of being flattened into "no
 * stage", which the seal cannot tell apart from a caller that forgot to materialise.
 */
async function stagedFor(input: FinalizeInput): Promise<{ staged: StagedPublication | null; refusal: FinalizeResult | null }> {
  if (input.staged) return { staged: input.staged, refusal: null };
  const readContent = input.readContent;
  if (!readContent) return { staged: null, refusal: null };
  const answer = await stageAttempt({ scopeId: input.scopeId, attemptId: input.attemptId, manifest: input.manifest, readContent, embed: input.embed });
  if (answer.code === STORE_CODE.STAGED) return { staged: answer.staged ?? null, refusal: null };
  // Only a scope's own refusal is answered here. Every other stage refusal is left to the fence,
  // which reads the same rows under its row lock and can tell a stale attempt from one an earlier
  // call already published.
  if (isScopeRefusal(answer.code)) return { staged: null, refusal: { code: answer.code, generationId: answer.generationId } };
  return { staged: null, refusal: null };
}

/** The codes that name the scope itself - its state, or its absence - and never a store failure. */
function isScopeRefusal(code: StoreCode): boolean {
  return (
    code === STORE_CODE.SCOPE_NOT_FOUND ||
    code === STORE_CODE.SCOPE_NOT_ACTIVE ||
    code === PROMOTION_OUTCOME.SCOPE_PAUSED ||
    code === PROMOTION_OUTCOME.SCOPE_REVOKED ||
    code === PROMOTION_OUTCOME.SCOPE_WITHDRAWN
  );
}

/**
 * Cleanup after a publication or an abandonment. The rows it removes were never visible, so a
 * failure here must not replace the answer the caller already has - the publication or abandonment
 * is decided either way - but it must not vanish silently either: rows nobody discards and no query
 * counts are the leak this cleanup exists to end, so a failure is logged for an operator to see.
 */
async function discardQuietly(what: string, cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[repo-index] ${what}: staged rows were not discarded: ${message}`);
  }
}

/**
 * Drops the rows of a stage that will not be published, and any stage of this source that can no
 * longer be promoted. Best effort in the sense that neither the publication nor the abandonment
 * changes because of it; a failure is logged rather than swallowed.
 */
async function discardUnpublishedStage(staged: StagedPublication | null): Promise<void> {
  if (!staged?.sourceId) return;
  const { sourceId, generationId, stageId } = staged;
  await discardQuietly(`publication ${generationId}`, async () => {
    await discardStaged(db, { sourceId, generationId, stageId });
    await sweepStaleStages(db, { sourceId });
  });
}

/** Thrown when the seal's conditional update matched nothing, so the transaction can roll back. */
class FencedAttempt extends Error {
  constructor(readonly generationId: string) {
    super(`${STORE_CODE.ATTEMPT_FENCED}: ${generationId}`);
  }
}

async function publish(tx: Transaction, input: FinalizeInput, staged: StagedPublication | null): Promise<FinalizeResult> {
  await boundLockWaits(tx);
  const scope = (await tx.repoIndexScope.findUnique({ where: { id: input.scopeId } })) as ScopeRow | null;
  if (!scope) return { code: STORE_CODE.SCOPE_NOT_FOUND };
  const attempt = await lockGeneration(tx, input.scopeId, input.attemptId);
  if (!attempt) return { code: STORE_CODE.ATTEMPT_NOT_FOUND };
  // Running finalize again on the attempt that won answers with the same publication.
  if (attempt.status === "published") return settledPublication(attempt, input.manifest);
  if (attempt.status === "abandoned") return { code: STORE_CODE.ATTEMPT_FENCED, generationId: attempt.id };
  if (attempt.status === "failed") return settledFailure(attempt);
  if (attempt.status !== "open") return { code: STORE_CODE.ATTEMPT_FENCED, generationId: attempt.id };

  const missingParts = await missingPartNumbers(tx, attempt);
  if (missingParts.length > 0) return { code: STORE_CODE.PARTS_MISSING, generationId: attempt.id, missingParts };

  // The fence decides before the materialisation is judged: a publication it refuses needs no
  // staged rows, and a caller whose stage was itself refused for the same reason (a base that had
  // already moved) has none to offer. Judging the stage first would turn that refusal into a bug
  // report about the module.
  const promotion = promoteAttempt({
    active: scopeState(scope),
    attempt: attemptReceipt(attempt),
    manifest: toManifest(input.manifest),
    requiredPaths: input.requiredPaths,
  });
  if (promotion.outcome !== PROMOTION_OUTCOME.PROMOTED) return fence(tx, attempt, promotion.outcome);

  // The publication declared materialisation (it carries a reader) and none was staged for it. The
  // seal must not happen: a generation whose chunks do not exist would answer searches with nothing.
  if (input.readContent && !staged) throw new UnstagedPublication(attempt.id);
  if (staged && (staged.generationId !== attempt.id || staged.scopeId !== input.scopeId)) throw new UnstagedPublication(attempt.id);

  const undeclared = await undeclaredDrops(tx, attempt, input);
  if (undeclared.length > 0) return fence(tx, attempt, STORE_CODE.UNDECLARED_DROP, { undeclaredDrops: undeclared });

  // The fence normalised the base compare; the write must repeat it, because two attempts can
  // read the same active generation before either commits. The scope's state is part of the
  // compare: a withdrawal that commits after the fence read must stop the publication too.
  const claimed = await tx.repoIndexScope.updateMany({
    where: { id: input.scopeId, activeGeneration: attempt.baseGeneration, state: "active" },
    data: { activeGeneration: attempt.generation },
  });
  if (claimed.count === 0) return fence(tx, attempt, await lostClaim(tx, input.scopeId));

  await writePaths(tx, attempt, input, staged?.anchors);
  await settleMaterialisation(tx, input, scope, staged);
  const published = await seal(tx, attempt);
  return staged ? { ...published, materialise: staged.materialise } : published;
}

/**
 * A publication that declared materialisation reached the seal with none: a bug of this module, not
 * of the caller. Thrown rather than answered so the transaction rolls back and the attempt stays
 * open, instead of sealing a generation whose contents search could never return.
 */
class UnstagedPublication extends Error {
  constructor(readonly generationId: string) {
    super(`the publication reached the seal without the materialisation it declared: ${generationId}`);
  }
}

/**
 * Applies the visibility half of a publication in the transaction that publishes it.
 *
 * A publication without a reader still owes the deletion half: the paths its manifest no longer
 * names stop being searchable, whether or not anything was read. That half needs no content, so a
 * metadata-only publication drops here - in this transaction - and a refused publication rolls the
 * drop back with everything else.
 *
 * A staged publication hands over the rows its stage wrote, which become live here or not at all.
 * The outcome it reports is what this publication really wrote; without a reader there is none.
 */
async function settleMaterialisation(
  tx: Transaction,
  input: FinalizeInput,
  scope: ScopeRow,
  staged: StagedPublication | null,
): Promise<void> {
  const paths = input.manifest.entries.map((entry) => ({ path: entry.path, digest: entry.digest }));
  if (staged) {
    // No source means this scope never materialised anything and this stage had nothing to write:
    // there is no row to make visible and none to retire.
    if (!staged.sourceId) return;
    await promoteStaged(tx, {
      sourceId: staged.sourceId,
      generationId: staged.generationId,
      stageId: staged.stageId,
      staged: staged.stagedPaths,
      kept: paths.map((entry) => entry.path),
    });
    return;
  }
  if (!input.readContent) {
    await retireUnlistedPaths(tx, { scopeId: input.scopeId, projectId: scope.projectId, paths });
  }
}

function settledFailure(attempt: GenerationRow): FinalizeResult {
  return { code: (attempt.failureCode ?? STORE_CODE.ATTEMPT_FENCED) as StoreCode, generationId: attempt.id };
}

/**
 * Re-finalizing the attempt that won answers its publication, but only for the manifest that
 * attempt declared. A retry that presents another manifest would otherwise be told it published a
 * tree that is not the one the scope serves.
 */
function settledPublication(attempt: GenerationRow, manifest: AttemptManifest): FinalizeResult {
  if (manifest.digest !== attempt.manifestDigest) return { code: STORE_CODE.ATTEMPT_CONFLICT, generationId: attempt.id };
  return {
    code: STORE_CODE.PUBLISHED,
    generationId: attempt.id,
    generation: attempt.generation,
    receiptDigest: attempt.receiptDigest ?? undefined,
  };
}

async function missingPartNumbers(tx: Transaction, attempt: GenerationRow): Promise<number[]> {
  const stored = (await tx.repoIndexPart.findMany({
    where: { generationId: attempt.id },
    select: { partNo: true },
  })) as Array<{ partNo: number }>;
  const present = new Set(stored.map((row) => row.partNo));
  const declared = Array.from({ length: attempt.partCount }, (_unused, index) => index + 1);
  return declared.filter((partNo) => !present.has(partNo));
}

/**
 * Writes the manifest's tree. A path the manifest names is replaced in one statement per batch
 * instead of one upsert per entry, because a 10,000-entry manifest must not become 10,000 round
 * trips inside one transaction. Path identity is (scopeId, path), so the row keeps its meaning;
 * only its synthetic id is renewed.
 *
 * The anchoring chunk comes from the stage: a path is named before its rows are visible, so the row
 * this writes already points at the chunk the same commit makes searchable.
 */
async function writePaths(
  tx: Transaction,
  attempt: GenerationRow,
  input: FinalizeInput,
  anchors: ReadonlyMap<string, string> | undefined,
): Promise<void> {
  const generationId = attempt.id;
  const rows = input.manifest.entries.map((entry) => ({
    scopeId: input.scopeId,
    generationId,
    path: entry.path,
    digest: entry.digest,
    lineStart: entry.lineStart ?? null,
    lineEnd: entry.lineEnd ?? null,
    chunkId: anchors?.get(entry.path) ?? entry.chunkId ?? null,
    state: "present",
    // createMany is not a create, so the @updatedAt column is filled here rather than by the client.
    updatedAt: new Date(),
  }));
  for (const batch of chunksOf(rows, PATH_BATCH)) {
    await tx.repoIndexPath.deleteMany({ where: { scopeId: input.scopeId, path: { in: batch.map((row) => row.path) } } });
    await tx.repoIndexPath.createMany({ data: batch });
  }
  // The manifest is the whole tree, so any row still pointing at an older generation was deleted
  // upstream. Naming the kept paths instead would put 10,000 parameters in this one statement.
  await tx.repoIndexPath.updateMany({
    where: { scopeId: input.scopeId, state: "present", generationId: { not: generationId } },
    data: { generationId, state: "tombstone" },
  });
}

/** Splits rows into batches small enough for one statement's parameter limit. */
function chunksOf<T>(rows: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < rows.length; start += size) batches.push(rows.slice(start, start + size));
  return batches;
}

/**
 * The paths this publication would drop without the attempt declaring them. The manifest is the
 * whole tree, so a path it omits is a deletion; a truncated or empty manifest would otherwise
 * replace the last good tree with nothing. The accepted parts name the deletions the caller
 * declared before it saw this manifest, and the guard matches them by path: a count would let two
 * tombstones for paths that never existed pay for erasing two real ones.
 */
async function undeclaredDrops(tx: Transaction, attempt: GenerationRow, input: FinalizeInput): Promise<string[]> {
  const present = (await tx.repoIndexPath.findMany({
    where: { scopeId: input.scopeId, state: "present" },
    select: { path: true },
  })) as Array<{ path: string }>;
  const declared = await declaredTombstones(tx, attempt.id);
  return undeclaredDroppedPaths(
    present.map((row) => row.path),
    input.manifest.entries.map((entry) => entry.path),
    declared,
  );
}

/** The drops a publication may not make: a present path it omits that no accepted part declared. */
export function undeclaredDroppedPaths(present: readonly string[], kept: readonly string[], declared: ReadonlySet<string>): string[] {
  const keptPaths = new Set(kept);
  return present.filter((path) => !keptPaths.has(path) && !declared.has(path));
}

/** The deletions the accepted parts of this attempt declared, by path. */
async function declaredTombstones(tx: Transaction, generationId: string): Promise<Set<string>> {
  const parts = (await tx.repoIndexPart.findMany({
    where: { generationId },
    select: { tombstonePaths: true },
  })) as Array<{ tombstonePaths: string[] | null }>;
  return new Set(parts.flatMap((part) => part.tombstonePaths ?? []));
}

/** Names why the scope refused the compare-and-swap, instead of blaming the base generation. */
async function lostClaim(tx: Transaction, scopeId: string): Promise<StoreCode> {
  const scope = (await tx.repoIndexScope.findUnique({ where: { id: scopeId } })) as ScopeRow | null;
  if (!scope) return STORE_CODE.SCOPE_NOT_FOUND;
  return scope.state === "active" ? PROMOTION_OUTCOME.SUPERSEDED_BASE : scopeRefusalCode(scope.state);
}

/**
 * The refusal a non-active scope carries, spelled exactly as the fence and the API spell it.
 * `scopeRefusal` is the one mapping; the fallback is what a state this store does not know gets,
 * and an active scope never reaches here because every caller asks after the readability check.
 */
function scopeRefusalCode(state: string): StoreCode {
  return scopeRefusal(scopeStatusOf(state)) ?? STORE_CODE.SCOPE_NOT_ACTIVE;
}

async function seal(tx: Transaction, attempt: GenerationRow): Promise<FinalizeResult> {
  const receiptDigest = receiptDigestFor(attempt);
  const publishedAt = new Date();
  // Conditional on the status this attempt was decided on: an abandon that committed first must
  // not be overwritten into a publication, so a zero count fences the attempt instead.
  const sealed = await tx.repoIndexGeneration.updateMany({
    where: { id: attempt.id, status: "open" },
    data: { status: "published", sealedAt: publishedAt, publishedAt, receiptDigest, failureCode: null },
  });
  if (sealed.count === 0) throw new FencedAttempt(attempt.id);
  return { code: STORE_CODE.PUBLISHED, generationId: attempt.id, generation: attempt.generation, receiptDigest };
}

function receiptDigestFor(attempt: GenerationRow): string {
  return hashIdempotencyPayload({
    scopeId: attempt.scopeId,
    attemptId: attempt.attemptId,
    generation: attempt.generation,
    revision: attempt.revision,
    manifestDigest: attempt.manifestDigest,
    partCount: attempt.partCount,
  });
}

/** Fences a refused attempt so it cannot accept parts or publish later, and repeats its code. */
async function fence(tx: Transaction, attempt: GenerationRow, code: StoreCode, detail: Partial<FinalizeResult> = {}): Promise<FinalizeResult> {
  await tx.repoIndexGeneration.updateMany({
    where: { id: attempt.id, status: "open" },
    data: { status: "failed", failureCode: code },
  });
  return { code, generationId: attempt.id, generation: attempt.generation, ...detail };
}

/**
 * Abandons an unpublished attempt. Abandoning twice answers with the same state, and a
 * published attempt cannot be abandoned because its generation is what readers see.
 *
 * It runs in a transaction like the other writes, so the row lock it needs has the same bounded
 * wait: an abandon queued behind a publication answers as retryable contention, not a hung request.
 */
export async function abandonAttempt(input: { scopeId: string; attemptId: string }): Promise<AbandonResult> {
  try {
    const result = await prisma.$transaction((tx: Transaction) => abandonInTransaction(tx, input), TRANSACTION);
    if (result.code === STORE_CODE.ABANDONED) await discardAbandonedStage(input, result.generationId);
    return result;
  } catch (error) {
    if (isLockTimeout(error)) return { code: STORE_CODE.LOCK_TIMEOUT };
    throw error;
  }
}

/**
 * Drops what an abandoned attempt had staged, and any stage of the scope that can no longer be
 * promoted. The attempt can no longer publish, so no stage of it will ever become visible; the rows
 * are removed once the transaction that fenced it has committed.
 *
 * The sweep is what collects a batch a crashed writer landed after its own abandonment's discard
 * ran: that batch belongs to a generation this call was not the one to abandon, so the targeted
 * discard cannot see it.
 */
async function discardAbandonedStage(input: { scopeId: string; attemptId: string }, generationId: string | undefined): Promise<void> {
  if (!generationId) return;
  await discardQuietly(`abandonment of ${generationId}`, async () => {
    const scope = (await db.repoIndexScope.findUnique({ where: { id: input.scopeId }, select: { projectId: true } })) as
      | { projectId: string }
      | null;
    if (!scope) return;
    const source = (await db.source.findFirst({
      where: { projectId: scope.projectId, name: scopeSourceName(input.scopeId) },
      select: { id: true },
    })) as { id: string } | null;
    if (!source) return;
    await discardStaged(db, { sourceId: source.id, generationId });
    await sweepStaleStages(db, { sourceId: source.id });
  });
}

async function abandonInTransaction(tx: Transaction, input: { scopeId: string; attemptId: string }): Promise<AbandonResult> {
  await boundLockWaits(tx);
  const attempt = await loadGeneration(input.scopeId, input.attemptId, tx);
  if (!attempt) return { code: STORE_CODE.ATTEMPT_NOT_FOUND };
  if (attempt.status === "published") return { code: STORE_CODE.CANNOT_ABANDON_PUBLISHED, generationId: attempt.id };
  // A fenced attempt keeps the failure that fenced it: abandoning is not a failure, so the status
  // moves and the code that named the refusal stays readable.
  const fenced = await tx.repoIndexGeneration.updateMany({
    where: { id: attempt.id, status: { in: ["open", "failed"] } },
    data: { status: "abandoned" },
  });
  if (fenced.count > 0) return { code: STORE_CODE.ABANDONED, generationId: attempt.id };
  const current = await loadGeneration(input.scopeId, input.attemptId, tx);
  if (current?.status === "abandoned") return { code: STORE_CODE.ALREADY_ABANDONED, generationId: attempt.id };
  return { code: STORE_CODE.CANNOT_ABANDON_PUBLISHED, generationId: attempt.id };
}

/** The published receipt of one attempt, or of the most recently published generation. */
export async function readReceipt(input: { scopeId: string; attemptId?: string }): Promise<ReadReceiptResult> {
  const scope = (await db.repoIndexScope.findUnique({ where: { id: input.scopeId } })) as ScopeRow | null;
  if (!scope) return { code: STORE_CODE.SCOPE_NOT_FOUND };
  // A receipt names a tree the caller can then read, so a scope that may not be read hands none out.
  if (!isScopeReadable(scopeState(scope))) return { code: scopeRefusalCode(scope.state) };
  const row = (await db.repoIndexGeneration.findFirst({
    where: { scopeId: input.scopeId, status: "published", ...(input.attemptId ? { attemptId: input.attemptId } : {}) },
    // Newest first, and the generation breaks a tie: two publications can share a timestamp, and a
    // receipt that picked one of them at random would name a tree the scope no longer serves.
    orderBy: [{ publishedAt: "desc" }, { generation: "desc" }],
  })) as GenerationRow | null;
  if (!row || !row.receiptDigest || !row.publishedAt) return { code: STORE_CODE.RECEIPT_NOT_PUBLISHED };
  return {
    code: STORE_CODE.OK,
    receipt: {
      scopeId: row.scopeId,
      attemptId: row.attemptId,
      generation: row.generation,
      revision: Number(row.revision),
      manifestDigest: row.manifestDigest,
      receiptDigest: row.receiptDigest,
      publishedAt: row.publishedAt,
    },
  };
}

/**
 * One page of the manifest of one generation. The cursor carries the generation and the scope it
 * was issued for and is signed, so a later page can never be served from a newer generation or
 * from another scope's tree; a generation that is no longer the materialised one is reported as
 * expired, never as a newer tree.
 */
export async function readManifest(input: {
  scopeId: string;
  generation?: number;
  cursor?: string;
  limit?: number;
}): Promise<ManifestPage> {
  const limit = input.limit ?? 100;
  const position = input.cursor === undefined ? null : decodeCursor(input.cursor, input.scopeId);
  if (position === undefined) return { code: STORE_CODE.INVALID_CURSOR };
  if (position && input.generation !== undefined && position.generation !== input.generation) {
    return { code: STORE_CODE.INVALID_CURSOR };
  }
  // One repeatable-read snapshot for both reads: the scope row says which generation is visible
  // and the path rows say what it contains, and a promotion between the two would make an empty
  // page look like the pinned generation's tree instead of a generation that has been replaced.
  return prisma.$transaction(
    (tx: Transaction) => readManifestPage(tx, input, position, limit),
    { ...TRANSACTION, isolationLevel: "RepeatableRead" },
  );
}

async function readManifestPage(
  tx: Transaction,
  input: { scopeId: string; generation?: number },
  position: { generation: number; path: string } | null,
  limit: number,
): Promise<ManifestPage> {
  const scope = (await tx.repoIndexScope.findUnique({ where: { id: input.scopeId } })) as ScopeRow | null;
  if (!scope) return { code: STORE_CODE.SCOPE_NOT_FOUND };
  if (!isScopeReadable(scopeState(scope))) return { code: scopeRefusalCode(scope.state) };
  const pinned = position?.generation ?? input.generation ?? scope.activeGeneration;
  if (scope.activeGeneration === 0) return { code: STORE_CODE.NO_GENERATION_PUBLISHED };
  if (pinned !== scope.activeGeneration) return { code: STORE_CODE.GENERATION_EXPIRED, generation: pinned };

  const generation = await loadPublishedGeneration(scope.id, pinned, tx);
  if (!generation) return { code: STORE_CODE.GENERATION_EXPIRED, generation: pinned };

  const rows = (await tx.repoIndexPath.findMany({
    where: {
      scopeId: scope.id,
      generationId: generation.id,
      state: "present",
      ...(position ? { path: { gt: position.path } } : {}),
    },
    orderBy: { path: "asc" },
    take: limit + 1,
  })) as Array<ManifestPath & { state: string }>;

  // A promotion that commits after the scope read reassigns every path row to the new generation,
  // so this read can come back empty for a generation that is being replaced right now. Answering
  // OK with no entries would silently truncate the tree, so the moved generation is reported.
  const current = (await tx.repoIndexScope.findUnique({
    where: { id: scope.id },
    select: { activeGeneration: true },
  })) as { activeGeneration: number } | null;
  if (current?.activeGeneration !== pinned) return { code: STORE_CODE.GENERATION_EXPIRED, generation: pinned };

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    code: STORE_CODE.OK,
    generation: pinned,
    entries: page.map(toManifestPath),
    nextCursor: last && rows.length > limit ? encodeCursor({ scopeId: scope.id, generation: pinned, path: last.path }) : null,
  };
}

function toManifestPath(row: ManifestPath): ManifestPath {
  return { path: row.path, digest: row.digest, lineStart: row.lineStart, lineEnd: row.lineEnd, chunkId: row.chunkId };
}

/** The position a page resumes at: the scope and generation it belongs to, and its last path. */
interface CursorPosition {
  scopeId: string;
  generation: number;
  path: string;
}

/**
 * Returns undefined for a cursor this store did not sign for this scope, and null when the caller
 * sent none. The payload is signed with HMAC-SHA256 (REPO_INDEX_CURSOR_SECRET), so a caller cannot
 * mint a position or move its own cursor to another scope by editing the base64 body.
 */
function decodeCursor(raw: string, scopeId: string): CursorPosition | null | undefined {
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const body = raw.slice(0, separator);
  if (!signatureMatches(body, raw.slice(separator + 1))) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    // Both sides of the scope comparison must be strings: two missing values are not one identity.
    const readable =
      typeof parsed?.scopeId === "string" &&
      parsed.scopeId === scopeId &&
      Number.isInteger(parsed?.generation) &&
      typeof parsed?.path === "string";
    return readable ? { scopeId, generation: parsed.generation, path: parsed.path } : undefined;
  } catch {
    return undefined;
  }
}

function encodeCursor(position: CursorPosition): string {
  const body = Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
  return `${body}.${signatureOf(body)}`;
}

function signatureOf(body: string): string {
  return createHmac("sha256", CURSOR_SECRET).update(body, "utf8").digest("base64url");
}

function signatureMatches(body: string, signature: string): boolean {
  const expected = Buffer.from(signatureOf(body), "utf8");
  const given = Buffer.from(signature, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Caps how long the rest of this transaction queues for a row lock. `SET LOCAL` lasts until the
 * transaction ends, and LOCK_TIMEOUT_MS is a module constant, so no caller text reaches the
 * statement. Below the transaction timeout, contention answers as a retryable refusal instead of
 * spending the whole budget and surfacing as an unhandled error.
 */
async function boundLockWaits(tx: Transaction): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
}

/**
 * True when a statement failed because it waited too long for a lock: PostgreSQL's lock_timeout
 * (55P03, which Prisma reports as a failed raw query P2010) or a transaction that expired while it
 * queued (P2028). Both are contention, so the caller retries instead of reading a 500.
 */
export function isLockTimeout(error: unknown): boolean {
  const failure = error as { code?: string; meta?: { code?: string } } | null;
  if (failure?.code === "P2028") return true;
  return failure?.code === "P2010" && String(failure.meta?.code) === "55P03";
}

/**
 * Takes the attempt's row lock for the rest of the transaction. Publishing, abandoning and
 * accepting a part all read or change that row's status, so they queue here instead of acting
 * on a status another writer is about to replace.
 */
async function lockGeneration(tx: Transaction, scopeId: string, attemptId: string): Promise<GenerationRow | null> {
  await tx.$queryRaw`
    SELECT "id" FROM "repo_index_generations"
    WHERE "scopeId" = ${scopeId} AND "attemptId" = ${attemptId}
    FOR UPDATE
  `;
  return loadGeneration(scopeId, attemptId, tx);
}

async function loadGeneration(scopeId: string, attemptId: string, handle: Transaction = db): Promise<GenerationRow | null> {
  return handle.repoIndexGeneration.findUnique({ where: { scopeId_attemptId: { scopeId, attemptId } } });
}

async function loadPublishedGeneration(scopeId: string, generation: number, handle: Transaction = db): Promise<GenerationRow | null> {
  return handle.repoIndexGeneration.findFirst({ where: { scopeId, generation, status: "published" } });
}

async function loadPart(generationId: string, partNo: number, handle: Transaction = db): Promise<PartRow | null> {
  return handle.repoIndexPart.findUnique({ where: { generationId_partNo: { generationId, partNo } } });
}

/**
 * The scope row keeps no revision column and no manifest digest of its own: the scope's
 * `state` plus its active generation number are what the fence compares.
 */
function scopeState(row: ScopeRow): ScopeState {
  return {
    scopeId: row.id,
    generation: row.activeGeneration,
    revision: 0,
    manifestDigest: null,
    status: scopeStatusOf(row.state),
  };
}

/** The scope row's state as the fence reads it; a state this store does not know is not readable. */
export function scopeStatusOf(state: string): ScopeStatus {
  if (state === "active" || state === "paused" || state === "withdrawn") return state;
  return "revoked";
}

/** The states a scope row can carry, as the schema documents the column; anything else is unknown. */
const SCOPE_STATE_VALUES = ["active", "paused", "withdrawn"] as const;

/**
 * The scope states a reader may see, in the form a SQL predicate needs: `state = ANY(...)`.
 *
 * Derived from the two functions the fence itself uses, never from a second list: `scopeStatusOf`
 * decides what an unknown state means (this store reads it as `revoked`) and `isScopeReadable`
 * decides whether a status is readable, so a search filtering on this list cannot disagree with the
 * fence about a scope. The row fields other than the state are placeholders; scopeState reads the
 * state alone.
 */
export const READABLE_SCOPE_STATES: readonly string[] = SCOPE_STATE_VALUES.filter((state) =>
  isScopeReadable(scopeState({ id: "", state, activeGeneration: 0, projectId: "", orgId: "" })),
);

function attemptReceipt(row: GenerationRow): AttemptReceipt {
  return {
    scopeId: row.scopeId,
    attemptId: row.attemptId,
    baseGeneration: row.baseGeneration,
    revision: Number(row.revision),
    manifestDigest: row.manifestDigest,
  };
}

function toManifest(manifest: AttemptManifest): Manifest {
  return {
    digest: manifest.digest,
    dimensions: manifest.dimensions,
    entries: manifest.entries.map((entry) => ({ path: entry.path, vector: entry.vector })),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
