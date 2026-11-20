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
 * (unreadable content, an unusable vector, a tree above the chunk ceiling) rolls back the seal, the
 * generation bump and the path rows together. No generation can be visible while half its chunks
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
  ) {
    super(path ? `${code}: ${path}` : code);
    this.name = "MaterialiseError";
  }
}

/**
 * Documented ceiling on the chunks one generation may materialise. It bounds the embedding work the
 * publish transaction performs, so an over-sized tree is refused instead of holding the transaction
 * (and the generation's row lock) open until it times out.
 */
export const MATERIALISE_LIMITS = {
  maxChunksPerGeneration: 2000,
} as const;

/** The source `type` that marks a source as this scope's mirror, never an ingested document set. */
export const REPO_INDEX_SOURCE_TYPE = "repo_index";

/** One source per scope: a document requires one, and the name keeps the unique key per scope. */
export function scopeSourceName(scopeId: string): string {
  return `repo-index:${scopeId}`;
}

/** Vectors per embedding request; a generation is several requests, never one unbounded call. */
const EMBED_BATCH = 64;

/** Same cap ingest applies to a stored chunk's search text. */
const SEARCH_CONTENT_LIMIT = 20_000;

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
 */
export async function prepareMaterialisation(input: PrepareInput): Promise<PreparedMaterialisation> {
  const { reuse, pending } = partitionByDigest(input.paths, input.previous);
  const prepared = await chunkPaths(pending, input.readContent, input.maxChunks ?? MATERIALISE_LIMITS.maxChunksPerGeneration);
  await embedChunks(prepared, input.embed ?? embedDocuments);
  return { reuse, pending: prepared };
}

async function chunkPaths(paths: readonly SourcePath[], readContent: ContentReader, maxChunks: number): Promise<PreparedPath[]> {
  const prepared: PreparedPath[] = [];
  let planned = 0;
  for (const entry of paths) {
    const content = await readContentOf(readContent, entry.path);
    const chunks = chunkFile(entry.path, content);
    planned += chunks.length;
    // Checked per file, not after the last one: an over-sized tree stops reading here, before a
    // single embedding request, instead of spending the whole transaction budget first.
    if (planned > maxChunks) throw new MaterialiseError(MATERIALISE_CODE.CHUNK_LIMIT, entry.path);
    prepared.push({ path: entry.path, digest: entry.digest, content, chunks: chunks.map((chunk) => ({ chunk, vector: [] })) });
  }
  return prepared;
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
  await dropRemovedPaths(handle, source.id, input.paths, previous);
  await refreshSourceCounts(handle, source.id);
  return {
    reused: reused.length,
    created: prepared.pending.length,
    chunks: prepared.pending.reduce((total, entry) => total + entry.chunks.length, 0),
  };
}

/**
 * The scope's own source, created once. `sources.projectId` is a real foreign key, so the scope's
 * project has to exist: a repository index is attributable to a project, not to a conversation.
 */
async function ensureScopeSource(handle: Database, input: MaterialiseInput): Promise<{ id: string }> {
  const where = { projectId: input.projectId, name: scopeSourceName(input.scopeId) };
  const existing = await handle.source.findFirst({ where, select: { id: true } });
  if (existing) return existing;
  return handle.source.create({
    data: {
      ...where,
      orgId: input.orgId,
      type: REPO_INDEX_SOURCE_TYPE,
      status: "READY",
      config: { repo_scope_id: input.scopeId },
    },
  });
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

/** Keeps the scope's synthetic source honest about what it now holds. */
async function refreshSourceCounts(handle: Database, sourceId: string): Promise<void> {
  const documentCount = await handle.document.count({ where: { sourceId } });
  const chunkCount = await handle.chunk.count({ where: { document: { sourceId } } });
  await handle.source.update({
    where: { id: sourceId },
    data: { documentCount, chunkCount, lastSyncAt: new Date(), status: "READY" },
  });
}
