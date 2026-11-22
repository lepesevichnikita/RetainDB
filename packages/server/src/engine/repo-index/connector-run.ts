/**
 * Committed-ref run: the seam that turns one complete connector read into one publication.
 *
 * `readCommittedRef` decides what a ref contains and the store decides what may become the
 * generation readers see; neither calls the other, so this module is the only place where
 * the two meet. It reads the ref once, refuses to publish anything short of a complete
 * pinned read, and only then opens one attempt, submits the manifest as bounded parts and
 * finalises it. A failure after the open abandons that attempt, so no half-open generation
 * is left behind.
 *
 * The store is a dependency rather than an import: store.ts builds a Prisma client as it
 * loads, so the real functions are resolved lazily and an in-memory run can inject its own.
 *
 * The published tree is the run's second input, and it comes from the store. Before the ref is
 * read, the run asks the store which paths the scope serves and hands that set to
 * `readCommittedRef` as the prior tree: a path the store publishes that the new tree no longer
 * names is then a deletion the receipt declares, instead of a drop the fence refuses as
 * undeclared. That is what the answer is for - the deletion set, not the fence's coverage
 * requirement, which can only ever restate this manifest. A store that cannot answer refuses the
 * run, because an unknown prior tree is not an empty one.
 *
 * A provider that cannot resolve the ref at all throws out of `readCommittedRef` by design:
 * that is the caller's adapter failure, not a refusal about the tree, so it propagates.
 *
 * The publication is materialised, not just recorded: the run supplies the store with a
 * `readContent` reader, and the store turns each path into searchable chunks inside the same
 * transaction that seals the generation. So a PUBLISHED answer means the tree can be found by
 * semantic search, and a blob that cannot be read refuses the publication (MATERIALISE_REFUSED
 * carrying CONTENT_UNAVAILABLE) instead of publishing a path row nothing can return.
 *
 * That claim is checked here rather than trusted: a PUBLISHED answer has to report the
 * materialisation it documents - every manifest path reused or created, and the chunk rows this
 * call wrote - and an answer that states none of it is a store-layer refusal (STORE_REFUSED), not
 * a publication. The one exception is a replayed attempt: store.ts answers the generation an
 * earlier run already published (settledPublication), and that run is the call that materialised.
 *
 * The reader answers from what the manifest scan already fetched. The scan digests every blob, so
 * fetching the same blob again for its text would double the run's API use and the provider's rate
 * limit for nothing; the content is retained under a byte budget (`contentCacheBytes`) and released
 * as materialisation consumes it, because holding a whole repository in memory is the other way to
 * pay for it. Beyond the budget the reader fetches the blob again at the same pinned commit.
 */

import { createHash } from "node:crypto";
import { readCommittedRef, REF_RUN_OUTCOME, type RefManifestEntry, type RefProvider, type RefRunOutcome, type RefRunRequest, type RefRunResult, type RefViolation } from "../../connectors/repo-ref.js";
import { MATERIALISE_CODE, MaterialiseError, type ContentReader, type MaterialiseCode, type MaterialiseOutcome } from "./materialise.js";
import { EMBEDDING_DIMENSIONS, isUsableVector } from "./receipt.js";
import type {
  AbandonResult,
  AttemptManifest,
  FinalizeInput,
  FinalizeResult,
  IndexedPath,
  ManifestPage,
  OpenAttemptInput,
  OpenAttemptResult,
  PartPayload,
  PutPartInput,
  PutPartResult,
  StoreCode,
} from "./store.js";

export const RUN_CODE = {
  /** The store published the attempt; no attempt is left open. */
  PUBLISHED: "PUBLISHED",
  /** The ref no longer points at the pinned commit, so nothing is published. */
  STALE_REF: "STALE_REF",
  /** The provider failed part way, so the tree is not full coverage. */
  INCOMPLETE_TREE: "INCOMPLETE_TREE",
  /** The tree holds an entry that cannot be read as a regular file inside its root. */
  UNSAFE_TREE: "UNSAFE_TREE",
  /** The context carries no usable embedding for a manifest path, so the run is not searchable. */
  MISSING_EMBEDDING: "MISSING_EMBEDDING",
  /**
   * The store could not say which paths it publishes. Without that answer there is no prior tree to
   * compute a deletion against, so the run refuses instead of treating an unknown tree as an empty
   * one and declaring no deletions at all.
   */
  PRIOR_TREE_UNKNOWN: "PRIOR_TREE_UNKNOWN",
  /** The store answered with a code that forbids this publication. */
  STORE_REFUSED: "STORE_REFUSED",
  /** A store call threw; the open attempt was abandoned when one existed. */
  STORE_FAILED: "STORE_FAILED",
  /**
   * The publication rolled back because it could not be materialised, so nothing is published and
   * the attempt that was opened is abandoned. `materialiseCode` names the content problem.
   */
  MATERIALISE_REFUSED: "MATERIALISE_REFUSED",
} as const;

export type RunCode = (typeof RUN_CODE)[keyof typeof RUN_CODE];

/** Which layer decided the run; null when the store published it. */
export type RefusalLayer = "connector" | "store" | "input";

/**
 * Which layer a materialisation refusal belongs to: the connector when the pinned blob could not be
 * delivered, the input when the tree is above the documented ceiling or the caller's embedder
 * answered a vector no search can read.
 */
const LAYER_FOR_MATERIALISE: Record<MaterialiseCode, RefusalLayer> = {
  [MATERIALISE_CODE.CONTENT_UNAVAILABLE]: "connector",
  [MATERIALISE_CODE.CHUNK_LIMIT]: "input",
  [MATERIALISE_CODE.EMBEDDING_UNAVAILABLE]: "input",
};

/**
 * The store codes this run reads, spelled as store.ts spells them. store.ts constructs a
 * Prisma client as it loads, so its STORE_CODE cannot be imported into a module that must
 * run without a database; typing each name as StoreCode keeps the compiler checking them.
 */
const STORE_REPLY = {
  OK: "OK",
  NO_GENERATION_PUBLISHED: "NO_GENERATION_PUBLISHED",
  ATTEMPT_OPEN: "ATTEMPT_OPEN",
  ATTEMPT_REPLAYED: "ATTEMPT_REPLAYED",
  PART_ACCEPTED: "PART_ACCEPTED",
  PART_REPLAYED: "PART_REPLAYED",
  PUBLISHED: "PUBLISHED",
  ABANDONED: "ABANDONED",
  ALREADY_ABANDONED: "ALREADY_ABANDONED",
} as const satisfies Record<string, StoreCode>;

/** One code per connector outcome, so no refusal is collapsed into another's answer. */
const CODE_FOR_OUTCOME: Record<RefRunOutcome, RunCode> = {
  [REF_RUN_OUTCOME.COMPLETE]: RUN_CODE.PUBLISHED,
  [REF_RUN_OUTCOME.STALE_REF]: RUN_CODE.STALE_REF,
  [REF_RUN_OUTCOME.INCOMPLETE_TREE]: RUN_CODE.INCOMPLETE_TREE,
  [REF_RUN_OUTCOME.UNSAFE_TREE]: RUN_CODE.UNSAFE_TREE,
};

/** Paths per part when the caller names none; the store's own API caps one part at 10_000. */
const DEFAULT_PART_SIZE = 500;

/** Paths per page when the run reads the published tree; store.ts's own default is 100. */
const PUBLISHED_PAGE = 1_000;

/**
 * A store that never finishes paging its manifest is broken, not slow; the run does not wait.
 * Exported because `connectors/repo-ref.ts` bounds tree enumeration at the same ceiling
 * (`TREE_PAGES_MAX`), and a test pins the two constants to each other.
 */
export const PUBLISHED_PAGES_MAX = 100;

/**
 * Blob content the scan may keep so materialisation reads each blob once. Bounded because the scan
 * walks the whole tree: a repository larger than this is materialised from blobs fetched again
 * rather than from a copy of itself held in memory. Exported because it is the default of
 * `CommittedRefRun.contentCacheBytes`, which a caller tunes for its own memory.
 */
export const CONTENT_CACHE_BYTES = 32 * 1024 * 1024;

/** Blob content the manifest scan already read, and the bytes it holds. */
interface RetainedContent {
  cache: Map<string, string>;
  bytes: number;
}

/**
 * The provider the scan reads through: it keeps what it read, so the digest and the chunk text of a
 * path come from one fetch instead of two. `budget` bounds what that costs in memory.
 */
function retainingProvider(provider: RefProvider, retained: RetainedContent, budget: number): RefProvider {
  return {
    resolveRef: (ref) => provider.resolveRef(ref),
    listTree: (commit, page) => provider.listTree(commit, page),
    async readBlob(commit, path) {
      const content = await provider.readBlob(commit, path);
      const bytes = Buffer.byteLength(content, "utf8");
      // A path the scan reads once is retained once: a second read is not a second copy.
      if (retained.cache.has(path) || retained.bytes + bytes > budget) return content;
      retained.cache.set(path, content);
      retained.bytes += bytes;
      return content;
    },
  };
}

/**
 * The reader materialisation gets: content the scan already read, released as it is consumed, or
 * the blob at the pinned commit when the budget left nothing to keep.
 */
function contentReader(provider: RefProvider, commit: string, retained: RetainedContent): ContentReader {
  return async (path) => {
    const held = retained.cache.get(path);
    if (held === undefined) return provider.readBlob(commit, path);
    retained.cache.delete(path);
    retained.bytes -= Buffer.byteLength(held, "utf8");
    return held;
  };
}

/**
 * Bytes the scan may retain. A caller's budget that cannot bound anything (negative, infinite, NaN)
 * retains nothing, so a broken value costs extra fetches instead of unbounded memory.
 */
function contentBudgetOf(contentCacheBytes: number | undefined): number {
  const budget = contentCacheBytes ?? CONTENT_CACHE_BYTES;
  return Number.isFinite(budget) && budget > 0 ? Math.trunc(budget) : 0;
}

/** The store calls a run needs; store.ts is the default and a fake is enough in tests. */
export interface PublicationStore {
  openAttempt(input: OpenAttemptInput): Promise<OpenAttemptResult>;
  putPart(input: PutPartInput): Promise<PutPartResult>;
  finalizeAttempt(input: FinalizeInput): Promise<FinalizeResult>;
  abandonAttempt(input: { scopeId: string; attemptId: string }): Promise<AbandonResult>;
  /**
   * One page of the manifest of the generation the scope currently publishes: store.ts's
   * `readManifest`, with the same paging. The run reads it to learn the published tree before it
   * reads the ref, because a deletion is a path that tree no longer names and there is nowhere
   * else to learn it.
   *
   * Optional because the store is injected: a store built before this question existed still
   * type-checks. Such a store makes the run refuse - see `publishedPaths` - so an unanswered
   * question can never be mistaken for "nothing is published".
   */
  readManifest?(input: { scopeId: string; generation?: number; cursor?: string; limit?: number }): Promise<ManifestPage>;
}

export interface CommittedRefContext {
  scopeId: string;
  attemptId: string;
  /** The generation the scope was observed at; the fence compares it at publish time. */
  baseGeneration: number;
  /** The scope revision this publication is. */
  revision: number;
  /**
   * The embedding of every manifest path, produced by the stage that owns chunking and
   * embedding. The fence publishes only searchable paths, so a complete tree without a
   * usable embedding here is refused instead of published as an unsearchable generation.
   */
  vectors: ReadonlyMap<string, number[]>;
  /** Paths per part; one part is one store call. */
  partSize?: number;
}

export interface CommittedRefRun {
  provider: RefProvider;
  /**
   * The ref to read and its bounds. Its `previousPaths` is not read: the prior tree is the
   * store's answer, so a caller cannot declare a deletion for a path the scope never published
   * and cannot hide one by leaving the field out.
   */
  request: RefRunRequest;
  context: CommittedRefContext;
  /** Defaults to the real store, loaded on first use. */
  store?: PublicationStore;
  /**
   * Bytes of blob content the run may keep between the manifest scan and materialisation, so a blob
   * the scan already read is not fetched again. Defaults to CONTENT_CACHE_BYTES; 0 keeps nothing,
   * which makes every materialisation read fetch the blob again.
   */
  contentCacheBytes?: number;
}

export interface CommittedRefRunResult {
  /** What the run decided: one code per connector outcome, plus the store's own answers. */
  code: RunCode;
  /** Which layer refused, or null when the store published the attempt. */
  layer: RefusalLayer | null;
  /** The commit the connector pinned; empty when the ref resolved to no commit. */
  commit: string;
  /** The connector's violations; only an unsafe tree reports them. */
  violations: RefViolation[];
  /** The connector's failure text, or the message of a store exception. */
  failure: string | null;
  /** The store's own code when the store decided; null otherwise. */
  storeCode: StoreCode | null;
  /** Parts the attempt declared; 0 when no attempt was opened. */
  partCount: number;
  /** True when an open attempt was abandoned after this outcome. */
  abandoned: boolean;
  /** The materialisation code a rolled-back publication carried; absent when it was not one. */
  materialiseCode?: MaterialiseCode;
  generationId?: string;
  generation?: number;
  receiptDigest?: string;
}

export async function runCommittedRef(input: CommittedRefRun): Promise<CommittedRefRunResult> {
  const store = input.store ?? (await realStore());
  // The prior tree is the store's answer and never the request's: a deletion is a path this
  // scope was actually serving, so a run that assumes it served nothing can never declare one.
  // Reading it first also means an unanswerable store stops the run before the ref is pinned.
  const prior = await publishedPaths(store, input.context.scopeId);
  if (!prior.ok) return priorTreeUnknown(prior);
  // The scan and materialisation read the same blobs at the same pinned commit, so the content the
  // scan already fetched is kept for materialisation instead of being fetched a second time.
  const retained: RetainedContent = { cache: new Map(), bytes: 0 };
  const scanning = retainingProvider(input.provider, retained, contentBudgetOf(input.contentCacheBytes));
  const ref = await readCommittedRef(scanning, { ...input.request, previousPaths: prior.paths });
  // Only a genuinely complete, pinned read may reach the store. Every other outcome is a
  // refusal value, so it returns here: no attempt is opened and nothing is abandoned,
  // because this run never opened one. `complete` and the exported outcome are both
  // checked so neither a mis-set flag nor a re-spelled code can publish a refused tree.
  if (!ref.complete || ref.outcome !== REF_RUN_OUTCOME.COMPLETE) return refusalOf(ref);
  const searchable = searchableEntries(ref.manifest, input.context.vectors);
  if (searchable.unusable.length > 0) return missingEmbedding(ref, searchable.unusable);
  return publish(ref, searchable.entries, input, store, contentReader(input.provider, ref.commit, retained));
}

async function publish(
  ref: RefRunResult,
  entries: IndexedPath[],
  input: CommittedRefRun,
  store: PublicationStore,
  readContent: ContentReader,
): Promise<CommittedRefRunResult> {
  const manifest = manifestOf(entries);
  const parts = partsOf(ref.deletions, entries, partSizeOf(input.context.partSize));
  let opened = false;
  try {
    const answer = await store.openAttempt(declared(input.context, manifest, parts.length));
    if (!isOpened(answer.code)) return storeAnswer(ref, answer.code);
    opened = true;
    // An attempt the store replayed was opened by an earlier run of this same declaration; only a
    // fresh one is published by this call, so only a fresh one owes this run its materialisation.
    const replayed = answer.code === STORE_REPLY.ATTEMPT_REPLAYED;
    return await settle(ref, store, input.context, manifest, parts, readContent, replayed);
  } catch (error) {
    return await failureOf(ref, store, input.context, error, opened, parts.length);
  }
}

/** Submits every part, then publishes; any refusal or throw leaves the attempt abandoned. */
async function settle(
  ref: RefRunResult,
  store: PublicationStore,
  context: CommittedRefContext,
  manifest: AttemptManifest,
  parts: PartPayload[],
  readContent: ContentReader,
  replayed: boolean,
): Promise<CommittedRefRunResult> {
  const refused = await submit(store, context, parts);
  if (refused !== null) return abandonedStoreAnswer(ref, store, context, refused.code, parts.length);
  return sealed(ref, store, context, manifest, parts.length, readContent, replayed);
}

async function submit(store: PublicationStore, context: CommittedRefContext, parts: PartPayload[]): Promise<PutPartResult | null> {
  for (let index = 0; index < parts.length; index++) {
    const answer = await store.putPart({ scopeId: context.scopeId, attemptId: context.attemptId, partNo: index + 1, part: parts[index] });
    if (!isStoredPart(answer.code)) return answer;
  }
  return null;
}

async function sealed(
  ref: RefRunResult,
  store: PublicationStore,
  context: CommittedRefContext,
  manifest: AttemptManifest,
  partCount: number,
  readContent: ContentReader,
  replayed: boolean,
): Promise<CommittedRefRunResult> {
  // The reader is what makes the publication searchable: the store materialises the generation on
  // the same transaction that seals it, so PUBLISHED cannot answer while chunks are missing.
  const finalized = await store.finalizeAttempt({
    scopeId: context.scopeId,
    attemptId: context.attemptId,
    requiredPaths: requiredPathsOf(manifest),
    manifest,
    readContent,
  });
  if (finalized.code !== STORE_REPLY.PUBLISHED) return abandonedStoreAnswer(ref, store, context, finalized.code, partCount);
  // A replayed attempt is the publication an earlier run of this declaration already made, so this
  // call has nothing of its own to report (store.ts settledPublication). A fresh attempt owes the
  // evidence: every manifest path reused or created, and the chunks this call wrote. A fresh open
  // whose finalize replays another run of the same attempt is refused with it, because this run
  // cannot tell that publication from a claim it never materialised.
  if (replayed || materialised(finalized.materialise, manifest.entries.length)) return published(ref, finalized, partCount);
  return unverified(await abandonedStoreAnswer(ref, store, context, finalized.code, partCount));
}

/**
 * The evidence a PUBLISHED answer owes: every manifest path reused from an earlier generation or
 * created by this call, and the chunk rows it wrote. Whole, non-negative counts only, and an
 * explicit zero is a real answer - an empty file contributes no chunk and an empty tree no path -
 * so an answer cannot satisfy this by leaving the field out, by omitting a count, or by reporting
 * counts that account for some other, smaller tree.
 */
function materialised(evidence: MaterialiseOutcome | undefined, pathCount: number): boolean {
  if (evidence === undefined) return false;
  const counts = [evidence.reused, evidence.created, evidence.chunks];
  if (!counts.every((count) => Number.isInteger(count) && count >= 0)) return false;
  return evidence.reused + evidence.created === pathCount;
}

/** A PUBLISHED answer that states no publication this run can report is a store-layer refusal. */
function unverified(answer: CommittedRefRunResult): CommittedRefRunResult {
  return { ...answer, failure: "the store answered PUBLISHED without the materialisation a publication requires" };
}

/** One code per ref property: the run has to satisfy every one before the store is asked. */
function searchableEntries(manifest: readonly RefManifestEntry[], vectors: ReadonlyMap<string, number[]>): { entries: IndexedPath[]; unusable: string[] } {
  const entries: IndexedPath[] = [];
  const unusable: string[] = [];
  for (const entry of manifest) {
    const vector = usableVector(vectors.get(entry.path));
    if (vector === undefined) unusable.push(entry.path);
    else entries.push({ path: entry.path, digest: entry.digest, vector });
  }
  return { entries, unusable };
}

/** isUsableVector answers a boolean; this narrows the same decision to a storable vector. */
function usableVector(vector: number[] | undefined): number[] | undefined {
  if (vector === undefined || !isUsableVector(vector, EMBEDDING_DIMENSIONS)) return undefined;
  return vector;
}

/** Names at most five paths, so a large tree cannot flood the answer. */
function missingEmbedding(ref: RefRunResult, unusable: string[]): CommittedRefRunResult {
  return { ...answerOf(ref, RUN_CODE.MISSING_EMBEDDING, "input"), failure: `no usable embedding for ${unusable.slice(0, 5).join(", ")}` };
}

/** The manifest one attempt publishes; its digest is the run's, never a caller's claim. */
function manifestOf(entries: IndexedPath[]): AttemptManifest {
  return { digest: digestOf(entries), dimensions: EMBEDDING_DIMENSIONS, entries };
}

/** The declared digest and the fence's comparison both use this, so they can never disagree. */
function digestOf(entries: readonly IndexedPath[]): string {
  const canonical = entries.map((entry) => `${entry.path}\u0000${entry.digest}`).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The parts of one attempt. A removal is not a manifest entry, so the connector's deletions
 * ride in the first part, where the receipt records them once instead of padding every chunk.
 */
function partsOf(deletions: readonly string[], entries: readonly IndexedPath[], partSize: number): PartPayload[] {
  const groups = groupsOf(entries.map((entry) => entry.path), partSize);
  // An empty tree still declares one part, so the attempt stays inside the store's 1..N range.
  if (groups.length === 0) groups.push([]);
  return groups.map((upserts, index) => ({ upserts, tombstones: index === 0 ? [...deletions] : [] }));
}

function groupsOf(paths: readonly string[], partSize: number): string[][] {
  const groups: string[][] = [];
  for (let start = 0; start < paths.length; start += partSize) groups.push(paths.slice(start, start + partSize));
  return groups;
}

/** Paths per part; never below one, so a caller's bad value cannot stall the upload. */
function partSizeOf(partSize: number | undefined): number {
  return Math.max(1, Math.trunc(partSize ?? DEFAULT_PART_SIZE));
}

function declared(context: CommittedRefContext, manifest: AttemptManifest, partCount: number): OpenAttemptInput {
  return { scopeId: context.scopeId, attemptId: context.attemptId, baseGeneration: context.baseGeneration, revision: context.revision, manifestDigest: manifest.digest, partCount };
}

/**
 * What the fence is told this publication must carry: this manifest's own paths, once each. The
 * fence refuses a required path its manifest does not hold (receipt.ts `everyRequirementCovered`),
 * so naming anything else - a published path this run drops, or a deletion - would make every
 * genuine deletion unpublishable. Requiring the manifest's paths is therefore a shape check and
 * never a deletion guard: a path the scope still serves and this manifest omits is refused by the
 * store's own undeclaredDrops (store.ts), against the tombstones the accepted parts declared.
 */
function requiredPathsOf(manifest: AttemptManifest): string[] {
  return [...new Set(manifest.entries.map((entry) => entry.path))];
}

function published(ref: RefRunResult, finalized: FinalizeResult, partCount: number): CommittedRefRunResult {
  return { ...answerOf(ref, RUN_CODE.PUBLISHED, null), partCount, generationId: finalized.generationId, generation: finalized.generation, receiptDigest: finalized.receiptDigest };
}

/** Either the paths the scope publishes, or why the store could not say. */
type PublishedTree = { ok: true; paths: string[] } | { ok: false; failure: string; storeCode: StoreCode | null };

/**
 * The paths the scope currently publishes, read from the store one page at a time.
 *
 * `NO_GENERATION_PUBLISHED` is an answer - the scope has never published, so its prior tree is
 * empty - while every other refusal, a throw and a paging loop mean the store cannot say. Any of
 * those refuses the run: treating an unknown prior tree as an empty one is what made a deletion
 * impossible to declare, and it is the deletions this answer decides. The store's own
 * undeclaredDrops is what refuses a manifest that silently drops a published path; the fence's
 * coverage requirement is only asked against this manifest, so nothing here can replace it.
 */
async function publishedPaths(store: PublicationStore, scopeId: string): Promise<PublishedTree> {
  const readManifest = store.readManifest;
  if (!readManifest) return { ok: false, failure: "the store cannot report the paths it publishes", storeCode: null };
  const paths: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PUBLISHED_PAGES_MAX; page++) {
    let answer: ManifestPage;
    try {
      answer = await readManifest({ scopeId, cursor, limit: PUBLISHED_PAGE });
    } catch (error) {
      return { ok: false, failure: messageOf(error), storeCode: null };
    }
    if (answer.code === STORE_REPLY.NO_GENERATION_PUBLISHED) {
      if (cursor !== undefined) return { ok: false, failure: "readManifest reported no generation after a page", storeCode: answer.code };
      return { ok: true, paths: [] };
    }
    if (answer.code !== STORE_REPLY.OK) return { ok: false, failure: `readManifest answered ${answer.code}`, storeCode: answer.code };
    paths.push(...(answer.entries ?? []).map((entry) => entry.path));
    const next = answer.nextCursor ?? null;
    if (next === null) return { ok: true, paths };
    if (next === cursor) return { ok: false, failure: "readManifest repeated a cursor", storeCode: answer.code };
    cursor = next;
  }
  return { ok: false, failure: `readManifest did not finish within ${PUBLISHED_PAGES_MAX} pages`, storeCode: null };
}

/** The store could not say what it publishes, so this run refuses before it pins anything. */
function priorTreeUnknown(published: { failure: string; storeCode: StoreCode | null }): CommittedRefRunResult {
  return {
    code: RUN_CODE.PRIOR_TREE_UNKNOWN,
    layer: "store",
    commit: "",
    violations: [],
    failure: published.failure,
    storeCode: published.storeCode,
    partCount: 0,
    abandoned: false,
  };
}

/** A refusal that left no attempt open, so there is nothing to abandon. */
function storeAnswer(ref: RefRunResult, storeCode: StoreCode): CommittedRefRunResult {
  return { ...answerOf(ref, RUN_CODE.STORE_REFUSED, "store"), storeCode };
}

async function abandonedStoreAnswer(ref: RefRunResult, store: PublicationStore, context: CommittedRefContext, storeCode: StoreCode, partCount: number): Promise<CommittedRefRunResult> {
  return { ...storeAnswer(ref, storeCode), partCount, abandoned: await abandonQuietly(store, context) };
}

/** A store call threw; the attempt is only abandoned when this run is the one that opened it. */
async function failureOf(ref: RefRunResult, store: PublicationStore, context: CommittedRefContext, error: unknown, opened: boolean, partCount: number): Promise<CommittedRefRunResult> {
  const abandoned = opened ? await abandonQuietly(store, context) : false;
  const refused = materialiseRefusal(error);
  if (refused !== null) {
    // The publish transaction rolled back, so the attempt it opened is still open and has to be
    // cleaned up; the refusal is the connector's or the caller's, never the store's.
    return { ...answerOf(ref, RUN_CODE.MATERIALISE_REFUSED, LAYER_FOR_MATERIALISE[refused]), failure: messageOf(error), partCount: opened ? partCount : 0, abandoned, materialiseCode: refused };
  }
  return { ...answerOf(ref, RUN_CODE.STORE_FAILED, "store"), failure: messageOf(error), partCount: opened ? partCount : 0, abandoned };
}

/** The materialisation code a rolled-back publication carried, or null when it was another failure. */
function materialiseRefusal(error: unknown): MaterialiseCode | null {
  return error instanceof MaterialiseError ? error.code : null;
}

/** Abandonment is best effort: a caller learns whether it happened instead of losing the refusal. */
async function abandonQuietly(store: PublicationStore, context: CommittedRefContext): Promise<boolean> {
  try {
    const answer = await store.abandonAttempt({ scopeId: context.scopeId, attemptId: context.attemptId });
    return isAbandoned(answer.code);
  } catch {
    return false;
  }
}

function refusalOf(ref: RefRunResult): CommittedRefRunResult {
  return { ...answerOf(ref, CODE_FOR_OUTCOME[ref.outcome], "connector"), violations: ref.violations, failure: ref.failure };
}

function answerOf(ref: RefRunResult, code: RunCode, layer: RefusalLayer | null): CommittedRefRunResult {
  return { code, layer, commit: ref.commit, violations: [], failure: null, storeCode: null, partCount: 0, abandoned: false };
}

function isOpened(code: StoreCode): boolean {
  return code === STORE_REPLY.ATTEMPT_OPEN || code === STORE_REPLY.ATTEMPT_REPLAYED;
}

function isStoredPart(code: StoreCode): boolean {
  return code === STORE_REPLY.PART_ACCEPTED || code === STORE_REPLY.PART_REPLAYED;
}

function isAbandoned(code: StoreCode): boolean {
  return code === STORE_REPLY.ABANDONED || code === STORE_REPLY.ALREADY_ABANDONED;
}

/** The real store, loaded only when nothing was injected, so a database-free run stays free. */
async function realStore(): Promise<PublicationStore> {
  const store = await import("./store.js");
  return {
    openAttempt: store.openAttempt,
    putPart: store.putPart,
    finalizeAttempt: store.finalizeAttempt,
    abandonAttempt: store.abandonAttempt,
    readManifest: store.readManifest,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
