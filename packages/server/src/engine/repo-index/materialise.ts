/**
 * Materialisation: the stage that turns a published repository generation into searchable rows.
 *
 * Publication writes `repo_index_paths` rows, and nothing in those rows can be returned by
 * semantic search. This module closes that gap. For each path of the generation it reads the file,
 * chunks it with the pipeline's own chunker, embeds the chunks, stores them as ordinary `chunks`
 * rows under a document of the scope's own source, and names the anchoring chunk on the path row.
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
 * Atomicity: the caller runs this on the transaction that publishes the generation, so a refusal
 * (unreadable content, an unusable vector, a generation above the chunk ceiling) rolls back the seal,
 * the generation bump and the path rows together. No generation can be visible while half its chunks
 * are missing, and the generation it replaced is untouched.
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
  generationId: string;
  projectId: string;
  orgId: string;
  paths: readonly SourcePath[];
  readContent: ContentReader;
  embed?: Embedder;
  maxChunks?: number;
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
 * Materialises one published generation and names each path's anchoring chunk on its path row.
 * Runs on the caller's transaction; every write rolls back with a refusal.
 */
export async function materialiseGeneration(handle: Database, input: MaterialiseInput): Promise<MaterialiseOutcome> {
  const source = await ensureScopeSource(handle, input);
  const previous = await loadMaterialisedPaths(handle, source.id);
  const previousByPath = new Map(previous.map((row) => [row.path, row]));
  const prepared = await prepareMaterialisation({
    paths: input.paths,
    previous: new Map(previous.map((row) => [row.path, { digest: row.digest, chunkIds: row.chunkIds }])),
    readContent: input.readContent,
    embed: input.embed,
    maxChunks: input.maxChunks,
  });
  const created = await writePendingPaths(handle, input, source.id, previousByPath, prepared.pending);
  const reused = prepared.reuse.map((entry) => ({ path: entry.path, chunkId: entry.chunkIds[0] }));
  await writeChunkAnchors(handle, input, [...reused, ...created]);
  await retirePaths(handle, source.id, input.paths, previous);
  return {
    reused: reused.length,
    created: prepared.pending.length,
    chunks: prepared.pending.reduce((total, entry) => total + entry.chunks.length, 0),
  };
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
  await retirePaths(handle, source.id, input.paths, await loadMaterialisedPaths(handle, source.id));
}

/**
 * The scope's own source, created once. `sources.projectId` is a real foreign key, so the scope's
 * project has to exist: a repository index is attributable to a project, not to a conversation.
 */
async function ensureScopeSource(handle: Database, input: MaterialiseInput): Promise<{ id: string }> {
  const existing = await findScopeSource(handle, input.scopeId, input.projectId);
  if (existing) return existing;
  return handle.source.create({
    data: {
      projectId: input.projectId,
      name: scopeSourceName(input.scopeId),
      orgId: input.orgId,
      type: REPO_INDEX_SOURCE_TYPE,
      status: "READY",
      config: { repo_scope_id: input.scopeId },
    },
  });
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

async function loadMaterialisedPaths(handle: Database, sourceId: string): Promise<MaterialisedDocument[]> {
  const documents = (await handle.document.findMany({
    where: { sourceId },
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

/** Writes every pending path's document and chunks, returning the anchor of each non-empty path. */
async function writePendingPaths(
  handle: Database,
  input: MaterialiseInput,
  sourceId: string,
  previousByPath: ReadonlyMap<string, MaterialisedDocument>,
  pending: readonly PreparedPath[],
): Promise<Array<{ path: string; chunkId: string }>> {
  const anchors: Array<{ path: string; chunkId: string }> = [];
  for (const entry of pending) {
    const existing = previousByPath.get(entry.path);
    const documentId = existing
      ? await replaceDocument(handle, input, existing.id, entry)
      : await createDocument(handle, input, sourceId, entry);
    const chunkIds = await insertChunks(handle, input, documentId, entry);
    if (chunkIds.length > 0) anchors.push({ path: entry.path, chunkId: chunkIds[0] });
  }
  return anchors;
}

function documentData(input: MaterialiseInput, entry: PreparedPath) {
  return {
    projectId: input.projectId,
    externalId: entry.path,
    title: entry.path,
    path: entry.path,
    contentHash: entry.digest,
    content: entry.content,
    tokens: Math.ceil(entry.content.length / 4),
    metadata: { repo_scope_id: input.scopeId, repo_path: entry.path, repo_digest: entry.digest },
    status: "READY",
    indexedAt: new Date(),
  };
}

async function createDocument(handle: Database, input: MaterialiseInput, sourceId: string, entry: PreparedPath): Promise<string> {
  const document = await handle.document.create({ data: { sourceId, ...documentData(input, entry) } });
  return document.id;
}

/** A changed digest replaces the path's chunks: the old ones describe text this tree no longer has. */
async function replaceDocument(handle: Database, input: MaterialiseInput, documentId: string, entry: PreparedPath): Promise<string> {
  await handle.chunk.deleteMany({ where: { documentId } });
  await handle.document.update({ where: { id: documentId }, data: documentData(input, entry) });
  return documentId;
}

async function insertChunks(handle: Database, input: MaterialiseInput, documentId: string, entry: PreparedPath): Promise<string[]> {
  const owner = { documentId, path: entry.path, digest: entry.digest, projectId: input.projectId, scopeId: input.scopeId };
  const ids: string[] = [];
  for (const prepared of entry.chunks) {
    const id = randomUUID();
    ids.push(id);
    await insertChunk(handle, { ...owner, id }, prepared);
  }
  return ids;
}

interface ChunkOwner {
  id: string;
  documentId: string;
  projectId: string;
  scopeId: string;
  path: string;
  digest: string;
}

/**
 * One chunk row, with its vector, written the way engine/ingest.ts writes a document chunk: the
 * pgvector column takes a literal, because Prisma has no client type for `Unsupported("vector")`.
 */
async function insertChunk(handle: Database, owner: ChunkOwner, prepared: PreparedChunk): Promise<void> {
  const metadata = JSON.stringify({
    ...prepared.chunk.metadata,
    repo_scope_id: owner.scopeId,
    repo_path: owner.path,
    repo_digest: owner.digest,
  });
  const tokens = Math.ceil(prepared.chunk.content.length / 4);
  const contentHash = createHash("sha256").update(prepared.chunk.content).digest("hex");
  const searchContent = searchContentFor(owner.path, prepared.chunk);
  await handle.$executeRaw`
    INSERT INTO "chunks" (
      id, "documentId", "projectId", content, "chunkType", "chunkIndex", metadata, tokens,
      "searchContent", "contentHash", "sectionPath", "headingPath", embedding, "createdAt", "updatedAt"
    )
    VALUES (
      ${owner.id}::uuid, ${owner.documentId}, ${owner.projectId}, ${prepared.chunk.content},
      ${prepared.chunk.chunkType}, ${prepared.chunk.chunkIndex}, ${metadata}::jsonb, ${tokens},
      ${searchContent}, ${contentHash}, ${prepared.chunk.sectionPath ?? null}, ${prepared.chunk.headingPath ?? null},
      ${`[${prepared.vector.join(",")}]`}::vector, NOW(), NOW()
    )
  `;
}

/** The path leads the text so a keyword search can match the file a hit came from. */
function searchContentFor(path: string, chunk: Chunk): string {
  return [path, chunk.headingPath, chunk.sectionPath, chunk.content].filter(Boolean).join("\n").slice(0, SEARCH_CONTENT_LIMIT);
}

/**
 * Names each path's anchoring chunk. One statement for the whole generation: a published tree can
 * name thousands of paths, and one update per path would spend the transaction on round trips.
 */
async function writeChunkAnchors(handle: Database, input: MaterialiseInput, anchors: ReadonlyArray<{ path: string; chunkId: string }>): Promise<void> {
  if (anchors.length === 0) return;
  await handle.$executeRaw`
    UPDATE "repo_index_paths" AS published
    SET "chunkId" = anchor."chunkId", "updatedAt" = NOW()
    FROM (
      SELECT UNNEST(${anchors.map((anchor) => anchor.path)}::text[]) AS "path",
             UNNEST(${anchors.map((anchor) => anchor.chunkId)}::text[]) AS "chunkId"
    ) AS anchor
    WHERE published."scopeId" = ${input.scopeId}
      AND published."generationId" = ${input.generationId}
      AND published."path" = anchor."path"
  `;
}

/** A path this manifest dropped must stop being searchable, or recall returns a file that is gone. */
async function dropRemovedPaths(handle: Database, sourceId: string, paths: readonly SourcePath[], previous: readonly MaterialisedDocument[]): Promise<void> {
  const kept = new Set(paths.map((entry) => entry.path));
  const removed = previous.filter((row) => !kept.has(row.path)).map((row) => row.id);
  if (removed.length > 0) await handle.document.deleteMany({ where: { id: { in: removed } } });
}

/** Drops what this generation no longer names, then keeps the source's counts honest about it. */
async function retirePaths(handle: Database, sourceId: string, paths: readonly SourcePath[], previous: readonly MaterialisedDocument[]): Promise<void> {
  await dropRemovedPaths(handle, sourceId, paths, previous);
  await refreshSourceCounts(handle, sourceId);
}

/** Keeps the scope's synthetic source honest about what it now holds. */
async function refreshSourceCounts(handle: Database, sourceId: string): Promise<void> {
  const documentCount = await handle.document.count({ where: { sourceId } });
  const chunkCount = await handle.chunk.count({ where: { document: { sourceId } } });
  await handle.source.update({
    where: { id: sourceId },
    data: { documentCount, chunkCount, lastSyncAt: new Date(), status: "READY" },
  });
}
