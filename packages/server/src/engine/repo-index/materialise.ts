/**
 * Materialisation: the stage that turns a repository generation into searchable rows, in two steps.
 *
 * Publication writes `repo_index_paths` rows, and nothing in those rows can be returned by
 * semantic search. This module closes that gap in the two phases the plan requires - stage before
 * promotion - so the transaction that publishes never carries the reading, chunking, embedding and
 * inserting of a whole tree.
 *
 * - `planMaterialisation` decides what the generation needs and reads, chunks and embeds the paths
 *   whose content changed. It writes nothing, so every refusal it raises (unreadable content, an
 *   unusable vector, the chunk ceiling) happens before the first row exists.
 * - `stageBatch` writes one bounded batch of that plan: a document per path and its chunks, under
 *   the scope's own source, marked with the attempt's generation and this stage's id. A staged
 *   document carries `deletedAt`, which is the invisibility rule the read path already applies:
 *   every query that returns a chunk joins `documents` with `deletedAt IS NULL`
 *   (engine/retriever.ts, all four branches of its text query and both of its vector queries), and
 *   every count here filters the same way. A staged row is therefore not searchable and not
 *   countable, and a crash between batches leaves the last good generation exactly as it was.
 * - `promoteStaged` is the visibility flip, and the caller runs it inside the transaction that
 *   fences the attempt and moves the scope's active generation: the staged rows become live at the
 *   same commit as the path rows that name them, and never before it.
 * - `discardStaged` drops the rows of a stage that will not be promoted. They were never visible,
 *   so this is garbage collection rather than a rollback.
 *
 * Scope of what is written, and why:
 * - One `sources` row per scope (`repo-index:<scopeId>`, type `repo_index`), because `documents`
 *   requires a `sourceId` and creation of a source requires a project. The trade-off is a visible
 *   synthetic source in the project's source list; the alternative (a shared source) would make two
 *   repositories in one project indistinguishable. Nothing is written to `memories`, `sessions` or
 *   `messages`, so repository text can never be recalled as conversation memory.
 * - One `documents` row per manifest path, keyed by `externalId = path` with `contentHash = digest`.
 *   That row is the idempotency record: the same digest under the same path means the chunks that
 *   already exist are still the ones this generation needs, so an unchanged reread is not embedded
 *   again. `chunks` and `documents` both carry `projectId`, so every result is attributable to the
 *   scope's project.
 * - Only searchable chunks are stored. A parent-context chunk carries no vector and no similarity
 *   query can return it, so storing it would be a row nothing reads.
 *
 * Atomicity: the staged rows are invisible until `promoteStaged` runs in the sealing transaction,
 * and that transaction is also what fences the attempt and moves the active generation. No
 * generation can be visible while half its chunks are missing - a half-staged generation is not
 * visible at all - and the generation it replaces stays searchable throughout.
 *
 * Content comes from the caller: `readContent` is the only way a file is read here, so this module
 * never reaches for the filesystem or the network and a caller can test it with plain strings.
 */

import { createHash, randomUUID } from "node:crypto";
import { chunkText, type Chunk } from "../chunker.js";
import { embed as embedDocuments } from "../embeddings.js";
import { EMBEDDING_DIMENSIONS, isUsableVector } from "./receipt.js";

/** Everything these queries run on: the publish transaction, narrowed like the store narrows it. */
type Database = any;

/** Reads the content of one manifest path. The caller owns where that content comes from. */
export type ContentReader = (path: string) => Promise<string>;

/** Turns texts into vectors; `embed` from engine/embeddings.ts is the production one. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

/** One path of the manifest being materialised. */
export interface SourcePath {
  path: string;
  digest: string;
}

/** What a previous materialisation left for one path: the digest it embedded and its chunk ids. */
export interface MaterialisedPath {
  digest: string;
  chunkIds: readonly string[];
}

/** A path the previous generation already embedded, reused as-is. */
export interface ReusedPath {
  path: string;
  digest: string;
  chunkIds: readonly string[];
}

/** One chunk of a path, with the vector that makes it searchable. */
export interface PreparedChunk {
  chunk: Chunk;
  vector: number[];
}

/** One path that has to be embedded for this generation. */
export interface PreparedPath {
  path: string;
  digest: string;
  content: string;
  chunks: PreparedChunk[];
}

export interface PreparedMaterialisation {
  reuse: ReusedPath[];
  pending: PreparedPath[];
}

export interface PrepareInput {
  paths: readonly SourcePath[];
  /** The paths the previous materialisation left behind, by path. */
  previous: ReadonlyMap<string, MaterialisedPath>;
  readContent: ContentReader;
  embed?: Embedder;
  maxChunks?: number;
}

export interface MaterialiseInput {
  scopeId: string;
  projectId: string;
  paths: readonly SourcePath[];
  readContent: ContentReader;
  embed?: Embedder;
  maxChunks?: number;
}

/** What one publication starts from and what it must write, decided before the first row. */
export interface MaterialisationPlan {
  /** The scope's source, or null when this scope never materialised anything. */
  sourceId: string | null;
  /** The paths whose chunks this generation keeps, with the chunks each of them anchors. */
  reuse: ReusedPath[];
  /** The paths this generation must write, read and chunked and embedded. */
  pending: PreparedPath[];
}

/** The two document metadata keys that tie a staged row to the attempt and the stage that wrote it. */
const STAGED_GENERATION_KEY = "repo_index_generation_id";
const STAGED_STAGE_KEY = "repo_index_stage_id";

/** The scope a source row belongs to: enough to find or create it. */
interface SourceOwner {
  scopeId: string;
  projectId: string;
  orgId: string;
}

/** One bounded batch of a plan, written in one transaction. */
export interface StageBatchInput extends SourceOwner {
  generationId: string;
  stageId: string;
  /** The moment this stage began; the value a staged document's `deletedAt` carries. */
  stagedAt: Date;
  paths: readonly PreparedPath[];
}

/** What one batch wrote: the source it staged into, and the chunk each of its paths anchors. */
export interface StagedBatch {
  sourceId: string;
  anchors: Array<{ path: string; chunkId: string }>;
}

export interface PromoteStagedInput {
  sourceId: string;
  generationId: string;
  stageId: string;
  /** The paths this stage wrote documents for; the live document of each is replaced by it. */
  staged: readonly string[];
  /** Every path the manifest names; a live document whose path is not here is retired. */
  kept: readonly string[];
}

export interface DiscardStagedInput {
  sourceId: string;
  generationId: string;
  /** The stage that owns the rows; every stage of the generation when absent. */
  stageId?: string;
}

/** The deletion half of materialisation: the paths a generation serves, and where they live. */
export interface RetireInput {
  scopeId: string;
  projectId: string;
  paths: readonly SourcePath[];
}

export interface MaterialiseOutcome {
  /** Paths whose existing chunks were named on the path row again. */
  reused: number;
  /** Paths that were read and chunked for this generation; an empty file contributes no chunk. */
  created: number;
  /** Chunk rows written by this call. */
  chunks: number;
}

export const MATERIALISE_CODE = {
  CHUNK_LIMIT: "CHUNK_LIMIT",
  CONTENT_UNAVAILABLE: "CONTENT_UNAVAILABLE",
  EMBEDDING_UNAVAILABLE: "EMBEDDING_UNAVAILABLE",
} as const;

export type MaterialiseCode = (typeof MATERIALISE_CODE)[keyof typeof MATERIALISE_CODE];

/** A refusal, carrying the code that decides the outcome and the path it happened on. */
export class MaterialiseError extends Error {
  constructor(
    readonly code: MaterialiseCode,
    readonly path?: string,
    /** The chunk tally behind a CHUNK_LIMIT refusal: what the generation would hold, and against what. */
    readonly tally?: ChunkTally,
  ) {
    super(refusalOf(code, path, tally));
    this.name = "MaterialiseError";
  }
}

/**
 * What one generation would hold against the ceiling it is measured against: the chunks a previous
 * publication already embedded and this one reuses, the chunks this one has planned so far, and the
 * knob that set the ceiling - the variable and its value, or the caller's own number.
 */
export interface ChunkTally {
  ceiling: number;
  reused: number;
  planned: number;
  source: string;
}

/**
 * The refusal as a caller reads it: the file it happened on, the chunks the generation had planned
 * by then, which part of them is new and which is reused, the ceiling in force and the setting it
 * came from.
 *
 * A first publication - the run every deployment makes - reuses nothing, and its refusal used to be
 * exactly `CHUNK_LIMIT: <path>`: no number, no ceiling and no setting, which tells an operator
 * neither whether the tree is too large, which number stopped it, nor where to raise it. So the
 * tally is stated for every publication, the reuse-free one included, and the split is spelled out
 * because it is what the generation would hold: the plan by this file, and none of it reused.
 */
function refusalOf(code: MaterialiseCode, path: string | undefined, tally: ChunkTally | undefined): string {
  const refusal = path ? `${code}: ${path}` : code;
  if (!tally) return refusal;
  return `${refusal}: planned ${tally.planned} chunks so far - ${tally.planned} new, ${tally.reused} reused - exceeding the ${tally.ceiling}-chunk ceiling set by ${tally.source}`;
}

/**
 * The variable that configures the ceiling a generation is measured against. Unset (or empty)
 * means `MATERIALISE_LIMITS.maxChunksPerGeneration`, so an existing deployment keeps the ceiling
 * it ran with; a repository larger than the default raises it instead of being refused.
 */
export const MATERIALISE_MAX_CHUNKS_ENV = "RETAINDB_REPO_INDEX_MAX_CHUNKS_PER_GENERATION";

/**
 * The ceiling on the chunks one generation may hold: the chunks a previous publication already
 * embedded and this one reuses, plus the chunks this one plans to embed. It bounds what the publish
 * transaction has to carry, so an over-sized generation is refused instead of holding the
 * transaction (and the generation's row lock) open until it times out. The reuse is counted because
 * a re-publication that keeps 5,000 chunks and plans 1,999 still holds 6,999: a ceiling that only
 * watched the new work would not be the budget it claims to be.
 *
 * `maxChunksPerGeneration` is the default an unconfigured process runs with;
 * `largestConfiguredChunks` is the most the variable may name, because a ceiling above it is a typo
 * rather than a repository - it is the same bound the index-bundle API puts on a chunk count. Both
 * are read by `maxChunksPerGeneration()`, so the default and its bound cannot drift from the
 * decision they describe.
 */
export const MATERIALISE_LIMITS = {
  maxChunksPerGeneration: 2000,
  largestConfiguredChunks: 200_000,
} as const;

/** How much of a refused value the message echoes: enough to recognise it, never a pasted payload. */
const ECHOED_CHARS = 40;

/**
 * The received value as the refusal states it: quoted, so a newline or a tab cannot forge or split a
 * log line, and clipped, so a 4 KB paste cannot become the message a caller reads or serves.
 */
function echoed(received: string): string {
  return JSON.stringify(received.length > ECHOED_CHARS ? `${received.slice(0, ECHOED_CHARS)}...` : received);
}

/**
 * A configured value that cannot be a ceiling. It is the process's configuration, not the tree it
 * was asked to publish, so it is named apart from `MaterialiseError`: a caller that reports store
 * failures must not read an operator's typo as a broken database, and the answer is "fix the
 * variable", not "this generation is too large".
 */
export class MaterialiseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialiseConfigurationError";
  }
}

/**
 * The ceiling in force for one materialisation: `MATERIALISE_MAX_CHUNKS_ENV` when it names a
 * whole number of chunks, the documented default when it is unset or empty.
 *
 * A value that cannot be a ceiling is refused here rather than clamped, and the refusal names the
 * variable and what it received: a clamped value would silently publish a tree an operator
 * believed they had allowed, or refuse one they had raised the ceiling for.
 */
export function maxChunksPerGeneration(): number {
  const received = process.env[MATERIALISE_MAX_CHUNKS_ENV];
  if (received === undefined || received.trim() === "") return MATERIALISE_LIMITS.maxChunksPerGeneration;
  // The separator is accepted because the largest ceiling is written `200_000` here and in the docs:
  // a variable that refused the spelling its own constant uses would be the incoherence, not the fix.
  const ceiling = Number(received.trim().replaceAll("_", ""));
  const accepted = Number.isInteger(ceiling) && ceiling >= 1 && ceiling <= MATERIALISE_LIMITS.largestConfiguredChunks;
  if (!accepted) {
    throw new MaterialiseConfigurationError(
      `${MATERIALISE_MAX_CHUNKS_ENV}=${echoed(received)} is not a chunk ceiling: set a whole number of chunks ` +
        `between 1 and ${MATERIALISE_LIMITS.largestConfiguredChunks}, or leave it unset for the default of ` +
        `${MATERIALISE_LIMITS.maxChunksPerGeneration}`,
    );
  }
  return ceiling;
}

/**
 * Reads the ceiling once as this module loads, so a process configured with a value that cannot be a
 * ceiling fails at start. The same validation used to run only when a generation was chunked: that is
 * inside the publish transaction, after the scope's row lock and after the seal, so a committed-ref
 * run answered `STORE_FAILED` with layer "store" and an operator's typo read as a broken database.
 *
 * The read inside `maxChunksPerGeneration` stays, because a process whose environment changes at
 * runtime must still be refused at the point of use; this call is what moves the common case - a
 * deployment started with a bad value - to load time, before any transaction exists to fail.
 */
function refuseInvalidChunkCeiling(): void {
  maxChunksPerGeneration();
}

refuseInvalidChunkCeiling();

/** The source `type` that marks a source as this scope's mirror, never an ingested document set. */
export const REPO_INDEX_SOURCE_TYPE = "repo_index";

/** One source per scope: a document requires one, and the name keeps the unique key per scope. */
export function scopeSourceName(scopeId: string): string {
  return `repo-index:${scopeId}`;
}

/** Vectors per embedding request; a generation is several requests, never one unbounded call. */
const EMBED_BATCH = 64;

/**
 * The cap on a stored chunk's search text. engine/ingest.ts imports it, so the pipeline and this
 * materialiser cannot write two different caps into `chunks.searchContent`.
 */
export const SEARCH_CONTENT_LIMIT = 20_000;

/**
 * Splits the manifest into paths whose chunks this generation can reuse and paths it must embed.
 * A digest alone is not a promise that chunks exist: a previous row without chunk ids would leave
 * this generation anchoring nothing, so only a digest that still has chunks is reused.
 */
export function partitionByDigest(
  paths: readonly SourcePath[],
  previous: ReadonlyMap<string, MaterialisedPath>,
): { reuse: ReusedPath[]; pending: SourcePath[] } {
  const reuse: ReusedPath[] = [];
  const pending: SourcePath[] = [];
  for (const entry of paths) {
    const known = previous.get(entry.path);
    if (known && known.digest === entry.digest && known.chunkIds.length > 0) {
      reuse.push({ path: entry.path, digest: entry.digest, chunkIds: known.chunkIds });
    } else {
      pending.push(entry);
    }
  }
  return { reuse, pending };
}

/**
 * Everything that must happen before the first row is written: decide what is already materialised,
 * read and chunk the rest, refuse beyond the ceiling, then embed. A refusal here means the caller's
 * transaction has not touched a row, so a failed materialisation cannot leave partial state.
 *
 * The ceiling is spent on the whole generation, not only on the new work: the chunks a publication
 * reuses are chunks the generation it serves will hold, so they are counted before the first read.
 */
export async function prepareMaterialisation(input: PrepareInput): Promise<PreparedMaterialisation> {
  const { reuse, pending } = partitionByDigest(input.paths, input.previous);
  const budget: ChunkBudget = {
    ceiling: input.maxChunks ?? maxChunksPerGeneration(),
    reused: reusedChunksOf(reuse),
    source: ceilingSource(input.maxChunks),
  };
  const prepared = await chunkPaths(pending, input.readContent, budget);
  await embedChunks(prepared, input.embed ?? embedDocuments);
  return { reuse, pending: prepared };
}

/**
 * The ceiling one materialisation is measured against, the chunks it reuses before it plans, and the
 * knob the number came from - which is what a refusal has to name if an operator is to act on it.
 */
interface ChunkBudget {
  ceiling: number;
  reused: number;
  source: string;
}

/**
 * Where the ceiling in force came from, as a refusal names it: the caller's own number when one is
 * injected, otherwise the variable and the value it holds - or that it is unset, which is the
 * documented default. Naming the variable is the point: `CHUNK_LIMIT: <path>` told an operator
 * neither which number refused the tree nor which setting would raise it.
 */
function ceilingSource(maxChunks: number | undefined): string {
  if (maxChunks !== undefined) return "the caller's maxChunks";
  const configured = process.env[MATERIALISE_MAX_CHUNKS_ENV];
  return configured === undefined || configured.trim() === "" ? `${MATERIALISE_MAX_CHUNKS_ENV} (unset, documented default)` : `${MATERIALISE_MAX_CHUNKS_ENV}=${configured}`;
}

/** The chunks a re-publication keeps: rows that stay searchable, and so count against the ceiling. */
function reusedChunksOf(reuse: readonly ReusedPath[]): number {
  return reuse.reduce((total, entry) => total + entry.chunkIds.length, 0);
}

async function chunkPaths(paths: readonly SourcePath[], readContent: ContentReader, budget: ChunkBudget): Promise<PreparedPath[]> {
  const prepared: PreparedPath[] = [];
  let planned = 0;
  // Judged before the first read: a publication that only renames paths still holds every chunk it
  // reuses, and a generation whose reuse alone crosses the ceiling has no room to plan anything.
  refuseAboveCeiling(budget, planned);
  for (const entry of paths) {
    const content = await readContentOf(readContent, entry.path);
    const chunks = chunkFile(entry.path, content);
    planned += chunks.length;
    // Checked per file, not after the last one: an over-sized tree stops reading here, before a
    // single embedding request, instead of spending the whole transaction budget first.
    refuseAboveCeiling(budget, planned, entry.path);
    prepared.push({ path: entry.path, digest: entry.digest, content, chunks: chunks.map((chunk) => ({ chunk, vector: [] })) });
  }
  return prepared;
}

/** Refuses once the generation - the reused chunks plus the planned ones - is over its ceiling. */
function refuseAboveCeiling(budget: ChunkBudget, planned: number, path?: string): void {
  if (budget.reused + planned <= budget.ceiling) return;
  throw new MaterialiseError(MATERIALISE_CODE.CHUNK_LIMIT, path, {
    ceiling: budget.ceiling,
    reused: budget.reused,
    planned,
    source: budget.source,
  });
}

async function readContentOf(readContent: ContentReader, path: string): Promise<string> {
  let content: unknown;
  try {
    content = await readContent(path);
  } catch {
    content = undefined;
  }
  // A reader that throws and a reader that answers with nothing both have no content for the path.
  // Judged here, at the boundary: passed on, a missing answer fails later as a TypeError that names
  // no path and carries no code, so a connector's unreadable blob is reported as the store's own
  // failure instead of the publication's refusal.
  if (typeof content !== "string") throw new MaterialiseError(MATERIALISE_CODE.CONTENT_UNAVAILABLE, path);
  return content;
}

/** The searchable chunks of one file; an empty file has none, and none is a valid answer. */
function chunkFile(path: string, content: string): Chunk[] {
  if (!content.trim()) return [];
  return chunkText(content, { filePath: path }).chunks.filter((chunk) => chunk.searchable);
}

async function embedChunks(prepared: PreparedPath[], embed: Embedder): Promise<void> {
  const units = prepared.flatMap((entry) => entry.chunks.map((chunk) => ({ path: entry.path, chunk })));
  for (let start = 0; start < units.length; start += EMBED_BATCH) {
    const batch = units.slice(start, start + EMBED_BATCH);
    const vectors = await embed(batch.map((unit) => unit.chunk.chunk.content));
    batch.forEach((unit, index) => {
      unit.chunk.vector = usableVector(vectors[index], unit.path);
    });
  }
}

/** A stored vector must be one semantic search can read, or the chunk is searchable but unfindable. */
function usableVector(vector: number[] | undefined, path: string): number[] {
  if (!isUsableVector(vector, EMBEDDING_DIMENSIONS)) throw new MaterialiseError(MATERIALISE_CODE.EMBEDDING_UNAVAILABLE, path);
  return vector as number[];
}

/**
 * Decides what one publication needs and reads, chunks and embeds everything it must write, without
 * touching a row. A refusal here - content that cannot be read, a vector no search can consume, a
 * generation above its chunk ceiling (`MATERIALISE_LIMITS`, or the variable that raises it) - leaves
 * the database exactly as it was, which is what lets the caller stage afterwards.
 *
 * The previous materialisation is read from the live documents only: a staged document is not part
 * of the generation readers see, so it can never be reused as if it were.
 */
export async function planMaterialisation(handle: Database, input: MaterialiseInput): Promise<MaterialisationPlan> {
  const source = await findScopeSource(handle, input.scopeId, input.projectId);
  const previous = source ? await loadMaterialisedPaths(handle, source.id) : [];
  const prepared = await prepareMaterialisation({
    paths: input.paths,
    previous: new Map(previous.map((row) => [row.path, { digest: row.digest, chunkIds: row.chunkIds }])),
    readContent: input.readContent,
    embed: input.embed,
    maxChunks: input.maxChunks,
  });
  return { sourceId: source?.id ?? null, reuse: prepared.reuse, pending: prepared.pending };
}

/**
 * Writes one bounded batch of a plan: a document per path plus its chunks, with `deletedAt` set and
 * the generation and stage that own them in their metadata. Runs on the caller's transaction, which
 * is why the caller keeps batches small; every row of a batch appears at once, and none of them is
 * visible until `promoteStaged`.
 *
 * Two statements write the batch, one for its documents and one for its chunks. A statement per row
 * is what made this phase round-trip bound: every chunk paid a round trip, so a real tree spent its
 * whole budget in a phase that never fails, it only gets slower as the tree grows. Both statements
 * name the same columns and the same values a row-at-a-time write named, which is what the staging
 * suite compares row by row.
 *
 * The scope's source is created here, on the first batch that needs one, and never on a publication
 * that only reuses what it already has.
 */
export async function stageBatch(handle: Database, input: StageBatchInput): Promise<StagedBatch> {
  const source = await ensureScopeSource(handle, input);
  const documents = input.paths.map((entry) => ({ id: randomUUID(), entry }));
  const chunks = stagedChunksOf(documents);
  await insertDocuments(handle, input, source.id, documents);
  await insertChunks(handle, input, chunks);
  return { sourceId: source.id, anchors: chunkAnchorsOf(chunks) };
}

/** One document a batch writes, under the id it will carry. */
interface StagedDocument {
  id: string;
  entry: PreparedPath;
}

/** One chunk row a batch writes, with the document it belongs to and the id it will carry. */
interface StagedChunk {
  id: string;
  documentId: string;
  path: string;
  digest: string;
  prepared: PreparedChunk;
}

/** Every chunk row of the batch, in plan order, the way the batch's paths hold them. */
function stagedChunksOf(documents: readonly StagedDocument[]): StagedChunk[] {
  return documents.flatMap(({ id, entry }) =>
    entry.chunks.map((prepared) => ({ id: randomUUID(), documentId: id, path: entry.path, digest: entry.digest, prepared })),
  );
}

/** The chunk each staged path anchors: its first chunk, which is where the path row points. */
function chunkAnchorsOf(chunks: readonly StagedChunk[]): Array<{ path: string; chunkId: string }> {
  const anchors = new Map<string, string>();
  for (const { path, id } of chunks) if (!anchors.has(path)) anchors.set(path, id);
  return [...anchors].map(([path, chunkId]) => ({ path, chunkId }));
}

/** The token estimate every document and chunk row carries: a quarter of its text. */
function tokenEstimate(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Makes one stage the generation readers see, inside the transaction that publishes it.
 *
 * Three writes, in this order, so that nothing is visible before the flip: the live documents of
 * the paths this stage rewrote are dropped, every live document the manifest no longer names is
 * dropped, and only then do the staged documents become live. A reader sees the generation it saw
 * before the commit, or the whole new one after it - never both halves of a replaced file.
 */
export async function promoteStaged(handle: Database, input: PromoteStagedInput): Promise<void> {
  await dropLiveDocuments(handle, input.sourceId, input.staged);
  await retireUnlistedDocuments(handle, input.sourceId, input.kept);
  await makeStagedLive(handle, input);
  await refreshSourceCounts(handle, input.sourceId);
}

/**
 * Drops the rows of a stage that will not be promoted. Without a stage id it drops every stage of
 * the generation, which is what an abandonment knows; the rows were invisible either way, so this
 * only decides whether they linger.
 */
export async function discardStaged(handle: Database, input: DiscardStagedInput): Promise<number> {
  const stage = input.stageId ?? null;
  const dropped = await handle.$executeRaw`
    DELETE FROM "documents"
    WHERE "sourceId" = ${input.sourceId}
      AND "deletedAt" IS NOT NULL
      AND metadata->>${STAGED_GENERATION_KEY} = ${input.generationId}
      AND (${stage}::text IS NULL OR metadata->>${STAGED_STAGE_KEY} = ${stage}::text)
  `;
  return Number(dropped ?? 0);
}

/**
 * The deletion half of materialisation on its own: every path this generation no longer names stops
 * being searchable, and the scope's source counts follow it. It reads no content, which is why a
 * publication that never read any - the metadata-only finalize route - owes this same drop; skipping
 * it leaves a chunk of a file the published generation does not contain, and recall returns it.
 *
 * Runs on the caller's transaction, so a refused publication rolls the drop back with the rest: the
 * generation the scope served keeps every chunk it had. A scope that was never materialised has no
 * source and nothing to drop, so this creates none.
 */
export async function retireUnlistedPaths(handle: Database, input: RetireInput): Promise<void> {
  const source = await findScopeSource(handle, input.scopeId, input.projectId);
  if (!source) return;
  await retireUnlistedDocuments(handle, source.id, input.paths.map((entry) => entry.path));
  await refreshSourceCounts(handle, source.id);
}

/**
 * The scope's own source, created once. `sources.projectId` is a real foreign key, so the scope's
 * project has to exist: a repository index is attributable to a project, not to a conversation.
 *
 * Two stages of one scope can reach this at the same time, and `@@unique([projectId, name])` lets
 * one create it; the loser reads the row the winner wrote instead of failing its batch.
 */
async function ensureScopeSource(handle: Database, input: SourceOwner): Promise<{ id: string }> {
  const existing = await findScopeSource(handle, input.scopeId, input.projectId);
  if (existing) return existing;
  try {
    return await handle.source.create({
      data: {
        projectId: input.projectId,
        name: scopeSourceName(input.scopeId),
        orgId: input.orgId,
        type: REPO_INDEX_SOURCE_TYPE,
        status: "READY",
        config: { repo_scope_id: input.scopeId },
      },
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "P2002") throw error;
    const winner = await findScopeSource(handle, input.scopeId, input.projectId);
    if (!winner) throw error;
    return winner;
  }
}

/** The source this scope mirrors into, or nothing when it was never materialised. */
async function findScopeSource(handle: Database, scopeId: string, projectId: string): Promise<{ id: string } | null> {
  return handle.source.findFirst({ where: { projectId, name: scopeSourceName(scopeId) }, select: { id: true } });
}

/** One materialised path: the document that mirrors it and the chunks it already has, in order. */
interface MaterialisedDocument {
  id: string;
  path: string;
  digest: string;
  chunkIds: string[];
}

/**
 * The live documents of one source and the chunks each of them holds. Live means `deletedAt IS
 * NULL`: a staged document mirrors a path the generation does not serve yet, so it is not something
 * a later plan may reuse, count or duplicate.
 */
async function loadMaterialisedPaths(handle: Database, sourceId: string): Promise<MaterialisedDocument[]> {
  const documents = (await handle.document.findMany({
    where: { sourceId, deletedAt: null },
    select: { id: true, externalId: true, contentHash: true },
  })) as Array<{ id: string; externalId: string | null; contentHash: string | null }>;
  if (documents.length === 0) return [];
  const chunks = (await handle.chunk.findMany({
    where: { documentId: { in: documents.map((document) => document.id) } },
    select: { id: true, documentId: true, chunkIndex: true },
    orderBy: { chunkIndex: "asc" },
  })) as Array<{ id: string; documentId: string; chunkIndex: number | null }>;
  const chunkIdsByDocument = new Map<string, string[]>();
  for (const chunk of chunks) {
    chunkIdsByDocument.set(chunk.documentId, [...(chunkIdsByDocument.get(chunk.documentId) ?? []), chunk.id]);
  }
  return documents.map((document) => ({
    id: document.id,
    path: document.externalId ?? "",
    digest: document.contentHash ?? "",
    chunkIds: chunkIdsByDocument.get(document.id) ?? [],
  }));
}

/**
 * The document of every path of a batch, in one statement. Each row carries the two markers the
 * promotion reads - the generation and the stage - and `deletedAt`, which is what keeps it out of
 * every query until `promoteStaged` clears it. `createdAt` keeps the column's own default.
 */
async function insertDocuments(handle: Database, input: StageBatchInput, sourceId: string, documents: readonly StagedDocument[]): Promise<void> {
  if (documents.length === 0) return;
  const entries = documents.map(({ entry }) => entry);
  await handle.$executeRaw`
    INSERT INTO "documents" (
      id, "sourceId", "projectId", "externalId", title, path, "contentHash", content, tokens,
      metadata, status, "deletedAt", "updatedAt"
    )
    SELECT t.id, ${sourceId}, ${input.projectId}, t.path, t.path, t.path, t."contentHash", t.content, t.tokens,
           t.metadata::jsonb, 'PENDING', ${input.stagedAt}::timestamp(3), NOW()
    FROM unnest(
      ${documents.map(({ id }) => id)}::uuid[],
      ${entries.map(({ path }) => path)}::text[],
      ${entries.map(({ digest }) => digest)}::text[],
      ${entries.map(({ content }) => content)}::text[],
      ${entries.map(({ content }) => tokenEstimate(content))}::int[],
      ${entries.map((entry) => stagedDocumentMetadata(input, entry))}::text[]
    ) AS t(id, path, "contentHash", content, tokens, metadata)
  `;
}

/** The metadata a staged document carries: its path, digest, scope and the two markers. */
function stagedDocumentMetadata(input: StageBatchInput, entry: PreparedPath): string {
  return JSON.stringify({
    repo_scope_id: input.scopeId,
    repo_path: entry.path,
    repo_digest: entry.digest,
    [STAGED_GENERATION_KEY]: input.generationId,
    [STAGED_STAGE_KEY]: input.stageId,
  });
}

/**
 * Every chunk row of a batch, in one statement, written the way engine/ingest.ts writes a document
 * chunk: the pgvector column takes a literal, because Prisma has no client type for
 * `Unsupported("vector")`. The arrays are the columns, one element per chunk, so the statement is
 * one column list whatever the batch holds and no parameter is spent per row.
 */
async function insertChunks(handle: Database, input: StageBatchInput, chunks: readonly StagedChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  await handle.$executeRaw`
    INSERT INTO "chunks" (
      id, "documentId", "projectId", content, "chunkType", "chunkIndex", metadata, tokens,
      "searchContent", "contentHash", "sectionPath", "headingPath", embedding, "createdAt", "updatedAt"
    )
    SELECT t.id, t."documentId", ${input.projectId}, t.content, t."chunkType", t."chunkIndex", t.metadata::jsonb, t.tokens,
           t."searchContent", t."contentHash", t."sectionPath", t."headingPath", t.embedding::vector, NOW(), NOW()
    FROM unnest(
      ${chunks.map(({ id }) => id)}::uuid[],
      ${chunks.map(({ documentId }) => documentId)}::text[],
      ${chunks.map(({ prepared }) => prepared.chunk.content)}::text[],
      ${chunks.map(({ prepared }) => prepared.chunk.chunkType)}::text[],
      ${chunks.map(({ prepared }) => prepared.chunk.chunkIndex)}::int[],
      ${chunks.map((chunk) => stagedChunkMetadata(input, chunk))}::text[],
      ${chunks.map(({ prepared }) => tokenEstimate(prepared.chunk.content))}::int[],
      ${chunks.map(({ path, prepared }) => searchContentFor(path, prepared.chunk))}::text[],
      ${chunks.map(({ prepared }) => createHash("sha256").update(prepared.chunk.content).digest("hex"))}::text[],
      ${chunks.map(({ prepared }) => prepared.chunk.sectionPath ?? null)}::text[],
      ${chunks.map(({ prepared }) => prepared.chunk.headingPath ?? null)}::text[],
      ${chunks.map(({ prepared }) => `[${prepared.vector.join(",")}]`)}::text[]
    ) AS t(id, "documentId", content, "chunkType", "chunkIndex", metadata, tokens, "searchContent", "contentHash", "sectionPath", "headingPath", embedding)
  `;
}

/** The metadata a chunk row carries: what the chunker wrote, plus the scope, path and digest. */
function stagedChunkMetadata(input: StageBatchInput, chunk: StagedChunk): string {
  return JSON.stringify({
    ...chunk.prepared.chunk.metadata,
    repo_scope_id: input.scopeId,
    repo_path: chunk.path,
    repo_digest: chunk.digest,
    // The generation that wrote this text. The document carries it too, but a search answer is built
    // from the CHUNK, so the chunk must carry it, or the answer cannot be labelled without reading a
    // path row that a later publication moves - which is the race this key exists to avoid.
    [STAGED_GENERATION_KEY]: input.generationId,
  });
}

/** The path leads the text so a keyword search can match the file a hit came from. */
function searchContentFor(path: string, chunk: Chunk): string {
  return [path, chunk.headingPath, chunk.sectionPath, chunk.content].filter(Boolean).join("\n").slice(0, SEARCH_CONTENT_LIMIT);
}

/** Drops the live documents of the given paths: the stage that rewrites them replaces their chunks. */
async function dropLiveDocuments(handle: Database, sourceId: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await handle.$executeRaw`
    DELETE FROM "documents"
    WHERE "sourceId" = ${sourceId} AND "deletedAt" IS NULL AND "externalId" = ANY(${[...paths]}::text[])
  `;
}

/** A path this manifest dropped must stop being searchable, or recall returns a file that is gone. */
async function retireUnlistedDocuments(handle: Database, sourceId: string, kept: readonly string[]): Promise<void> {
  await handle.$executeRaw`
    DELETE FROM "documents"
    WHERE "sourceId" = ${sourceId} AND "deletedAt" IS NULL AND NOT ("externalId" = ANY(${[...kept]}::text[]))
  `;
}

/**
 * The visibility flip: the documents this stage wrote stop being deleted, and are indexed from this
 * moment. The marker is the pair the stage wrote into their metadata, so a document another stage
 * wrote - a concurrent one, or one that crashed - stays invisible instead of riding along.
 */
async function makeStagedLive(handle: Database, input: PromoteStagedInput): Promise<void> {
  await handle.$executeRaw`
    UPDATE "documents"
    SET "deletedAt" = NULL, "status" = 'READY', "indexedAt" = NOW(), "updatedAt" = NOW()
    WHERE "sourceId" = ${input.sourceId}
      AND "deletedAt" IS NOT NULL
      AND metadata->>${STAGED_GENERATION_KEY} = ${input.generationId}
      AND metadata->>${STAGED_STAGE_KEY} = ${input.stageId}
  `;
}

/**
 * Keeps the scope's synthetic source honest about what it now holds. Counts the live rows only: a
 * staged document is not part of the index, and a count that included it would describe text no
 * search could return.
 */
async function refreshSourceCounts(handle: Database, sourceId: string): Promise<void> {
  const documentCount = await handle.document.count({ where: { sourceId, deletedAt: null } });
  const chunkCount = await handle.chunk.count({ where: { document: { sourceId, deletedAt: null } } });
  await handle.source.update({
    where: { id: sourceId },
    data: { documentCount, chunkCount, lastSyncAt: new Date(), status: "READY" },
  });
}
