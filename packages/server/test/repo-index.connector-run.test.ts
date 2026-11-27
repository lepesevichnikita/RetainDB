import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REF_RUN_OUTCOME,
  type RefProvider,
  type RefTreeEntry,
  type RefRunRequest,
} from "../src/connectors/repo-ref.js";
import { PROMOTION_OUTCOME, EMBEDDING_DIMENSIONS } from "../src/engine/repo-index/receipt.js";
import {
  MATERIALISE_CODE,
  prepareMaterialisation,
  type Embedder,
  type MaterialiseOutcome,
  type PreparedMaterialisation,
  type SourcePath,
} from "../src/engine/repo-index/materialise.js";
import {
  RUN_CODE,
  runCommittedRef,
  type CommittedRefContext,
  type PublicationStore,
} from "../src/engine/repo-index/connector-run.js";
import type { FinalizeInput, OpenAttemptInput, PutPartInput, StoreCode } from "../src/engine/repo-index/store.js";

/**
 * The store answers with the codes below and cannot be imported at run time: store.ts
 * constructs a Prisma client as it loads, which a database-free suite must not do. The
 * literals here are the store's own spelling, which the run has to pass through verbatim.
 */
const STORE_REPLY = {
  OK: "OK",
  NO_GENERATION_PUBLISHED: "NO_GENERATION_PUBLISHED",
  SCOPE_NOT_FOUND: "SCOPE_NOT_FOUND",
  ATTEMPT_OPEN: "ATTEMPT_OPEN",
  ATTEMPT_REPLAYED: "ATTEMPT_REPLAYED",
  ATTEMPT_CONFLICT: "ATTEMPT_CONFLICT",
  PART_ACCEPTED: "PART_ACCEPTED",
  PART_CONFLICT: "PART_CONFLICT",
  PUBLISHED: "PUBLISHED",
  ABANDONED: "ABANDONED",
} as const;

const GENERATION_ID = "generation-1";
const RECEIPT_DIGEST = "receipt-digest-1";
/** Lowercase commit shas a provider would really answer with. */
const SHA_PINNED = "9f1e2d4c7b6a58f30d2e1c0b9a8f7e6d5c4b3a29";
const SHA_MOVED = "0c11ee7b6a58f30d2e1c0b9a8f7e6d5c4b3a2900";
const STORE_IDENTITY = { scopeId: "scope-1", attemptId: "attempt-1" };

interface FakeRepo {
  /** Blob content at the pinned commit, addressed by relative path. */
  files: Record<string, string>;
  /** Tree entries served instead of one regular-file entry per blob. */
  tree?: RefTreeEntry[];
  /** What the ref points at when the run starts. */
  head?: string;
  /** What the ref points at once it has moved, which stops a run before publication. */
  movedHead?: string;
  /** Tree page number the provider fails to serve. */
  failTreePage?: number;
  /** Blob path the provider fails to read. */
  failBlob?: string;
  /** Blob path the provider serves once and fails on every later read. */
  failBlobReread?: string;
}

// Fake provider: one immutable commit, one tree page, and a branch that can move
// between the pin and the freshness checks, so no database and no network is involved.
function fakeProvider(repo: FakeRepo) {
  const calls = { resolved: [] as string[], tree: [] as number[], blobs: [] as string[] };
  const reads = new Map<string, number>();
  const provider: RefProvider = {
    async resolveRef(ref: string) {
      calls.resolved.push(ref);
      // A later resolution is the freshness check that follows the tree read.
      return repo.movedHead && calls.resolved.length > 1 ? repo.movedHead : (repo.head ?? SHA_PINNED);
    },
    async listTree(_commit: string, page: number) {
      calls.tree.push(page);
      if (page !== 1) throw new Error(`tree page ${page} requested after the tree was fully served`);
      if (repo.failTreePage === page) throw new Error(`tree page ${page} unavailable`);
      return { entries: repo.tree ?? Object.keys(repo.files).map(entryOf), nextPage: null };
    },
    async readBlob(_commit: string, path: string) {
      calls.blobs.push(path);
      const read = (reads.get(path) ?? 0) + 1;
      reads.set(path, read);
      const content = repo.files[path];
      if (content === undefined || repo.failBlob === path) throw new Error(`blob ${path} unavailable`);
      if (repo.failBlobReread === path && read > 1) throw new Error(`blob ${path} unavailable on reread ${read}`);
      return content;
    },
  };
  return { provider, calls };
}

function entryOf(path: string): RefTreeEntry {
  return { path, type: "blob", mode: "100644" };
}

/**
 * Fake store: records every call it receives so a test can prove which writes happened,
 * and answers with the store's own codes. `present` is the tree it says it currently
 * publishes: the run has to learn the prior tree from here, because nothing in production
 * fills a request's previousPaths.
 *
 * It also materialises, the way store.ts does: the caller's reader is asked for every path the
 * scope has not already embedded, so a run that forgets to supply one publishes a tree with no
 * chunks here exactly as it would in the database.
 */
function fakeStore(
  options: {
    openCode?: StoreCode;
    failPartNo?: number;
    refusePartNo?: number;
    finalizeCode?: StoreCode;
    /** Paths the store says the scope currently publishes. */
    present?: string[];
    /** Answers this code instead of the published tree, so the run cannot learn it. */
    presentCode?: StoreCode;
    /** A store built before the manifest read existed: it cannot report what it publishes. */
    blind?: boolean;
    /** The embedder materialisation uses; the production one would reach a provider. */
    embed?: Embedder;
    /**
     * Answers PUBLISHED without the materialisation outcome store.ts attaches to a publication, so
     * the run's evidence check is what has to refuse the claim.
     */
    omitMaterialise?: boolean;
    /** Answers PUBLISHED with this outcome instead of the one it performed. */
    materialiseAs?: MaterialiseOutcome;
  } = {},
) {
  const calls = {
    opened: [] as OpenAttemptInput[],
    parts: [] as PutPartInput[],
    finalized: [] as FinalizeInput[],
    abandoned: [] as Array<{ scopeId: string; attemptId: string }>,
    manifests: [] as Array<{ scopeId: string; generation?: number; cursor?: string; limit?: number }>,
    /** Every materialisation this store performed, in call order. */
    materialised: [] as StoreMaterialisation[],
  };
  /** What this scope's published documents hold, as the next materialisation reads them. */
  const memory: MaterialisedMemory = new Map();
  const store: PublicationStore = {
    async openAttempt(input) {
      calls.opened.push(input);
      if (options.openCode) return { code: options.openCode };
      return { code: STORE_REPLY.ATTEMPT_OPEN, generationId: GENERATION_ID, generation: 1 };
    },
    async putPart(input) {
      calls.parts.push(input);
      if (options.failPartNo === input.partNo) throw new Error(`part ${input.partNo} could not be stored`);
      if (options.refusePartNo === input.partNo) return { code: STORE_REPLY.PART_CONFLICT, partNo: input.partNo };
      return { code: STORE_REPLY.PART_ACCEPTED, partNo: input.partNo };
    },
    async finalizeAttempt(input) {
      calls.finalized.push(input);
      if (options.finalizeCode) return { code: options.finalizeCode, generationId: GENERATION_ID };
      // A refusal thrown here is what the real publish transaction does: everything it wrote rolls
      // back, and the run gets the refusal to report and an open attempt to abandon.
      const materialised = await materialiseLikeStore(input, memory, options.embed ?? fakeEmbed);
      if (materialised) calls.materialised.push(materialised);
      // A published generation says what it materialised, exactly as store.ts does: without that
      // answer a PUBLISHED code alone would claim a searchability nothing established.
      const evidence = options.materialiseAs ?? (materialised && !options.omitMaterialise ? outcomeOf(materialised.prepared) : undefined);
      return {
        code: STORE_REPLY.PUBLISHED,
        generationId: GENERATION_ID,
        generation: 1,
        receiptDigest: RECEIPT_DIGEST,
        ...(evidence ? { materialise: evidence } : {}),
      };
    },
    async abandonAttempt(input) {
      calls.abandoned.push(input);
      return { code: STORE_REPLY.ABANDONED, generationId: GENERATION_ID };
    },
    ...(options.blind ? {} : { readManifest: (input) => readPublished(options, calls, input) }),
  };
  return { store, calls };
}

/** One materialisation the store performed, and how many blobs its reader had to answer. */
interface StoreMaterialisation {
  prepared: PreparedMaterialisation;
  reads: number;
}

/** What a published document row says: the digest it was written for and the chunks it holds. */
type MaterialisedMemory = Map<string, { digest: string; chunkIds: string[] }>;

/** An embedder that answers usable vectors without reaching a provider. */
const fakeEmbed: Embedder = async (texts) => texts.map(() => vector());

/**
 * The store's materialisation step, as store.ts performs it: the paths whose digest the previous
 * generation did not embed are read, chunked and embedded inside the publication, and the rest are
 * reused. A refusal throws out of here exactly as it throws out of the publish transaction.
 */
async function materialiseLikeStore(
  input: FinalizeInput,
  memory: MaterialisedMemory,
  embed: Embedder,
): Promise<StoreMaterialisation | null> {
  const readContent = input.readContent;
  // No reader means the store publishes path rows only, which is what it did before chunks existed.
  if (!readContent) return null;
  let reads = 0;
  const paths: SourcePath[] = input.manifest.entries.map((entry) => ({ path: entry.path, digest: entry.digest }));
  const prepared = await prepareMaterialisation({
    paths,
    previous: memory,
    readContent: async (path: string) => {
      reads++;
      return readContent(path);
    },
    embed,
  });
  rememberPublished(memory, paths, prepared);
  return { prepared, reads };
}

/**
 * The outcome store.ts reports for a publication: every path reused from a previous generation or
 * created here, and the chunk rows this call wrote. An empty tree answers three explicit zeroes,
 * so a PUBLISHED answer always states what it materialised instead of leaving it to be assumed.
 */
function outcomeOf(prepared: PreparedMaterialisation): MaterialiseOutcome {
  return {
    reused: prepared.reuse.length,
    created: prepared.pending.length,
    chunks: prepared.pending.reduce((total, entry) => total + entry.chunks.length, 0),
  };
}

/** What a publication leaves for the next one: the digest of each path and the chunk ids it holds. */
function rememberPublished(memory: MaterialisedMemory, paths: readonly SourcePath[], prepared: PreparedMaterialisation): void {
  const kept = new Set(paths.map((entry) => entry.path));
  for (const path of [...memory.keys()]) if (!kept.has(path)) memory.delete(path);
  for (const entry of prepared.pending) {
    memory.set(entry.path, { digest: entry.digest, chunkIds: entry.chunks.map((_chunk, index) => `${entry.path}#${index}`) });
  }
}

/** One manifest page of the fake scope, so a run reads its prior tree exactly as it would from store.ts. */
function readPublished(
  options: { present?: string[]; presentCode?: StoreCode },
  calls: { manifests: Array<{ scopeId: string; cursor?: string }> },
  input: { scopeId: string; generation?: number; cursor?: string; limit?: number },
) {
  calls.manifests.push(input);
  if (options.presentCode) return Promise.resolve({ code: options.presentCode });
  const entries = (options.present ?? []).map((path) => ({ path, digest: "digest-1", lineStart: null, lineEnd: null, chunkId: null }));
  return Promise.resolve({ code: STORE_REPLY.OK, generation: 1, entries, nextCursor: null });
}

/**
 * No call of any kind reached the store. A refused run must not open an attempt, store a
 * part, finalize or abandon: any one of those writes would publish or half-open a
 * generation for a tree the connector refused, and an abandonment would kill an attempt
 * id this run never opened.
 */
function assertNoStoreCalls(calls: ReturnType<typeof fakeStore>["calls"]): void {
  assert.deepEqual(
    {
      opened: calls.opened.length,
      parts: calls.parts.length,
      finalized: calls.finalized.length,
      abandoned: calls.abandoned.length,
    },
    { opened: 0, parts: 0, finalized: 0, abandoned: 0 },
  );
}

/** A vector the publication fence accepts: wide enough, finite and not all zero. */
function vector(): number[] {
  const values = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  values[0] = 1;
  return values;
}

function vectorsFor(paths: string[]): Map<string, number[]> {
  return new Map(paths.map((path) => [path, vector()]));
}

function contextFor(vectors: Map<string, number[]>, extra: Partial<CommittedRefContext> = {}): CommittedRefContext {
  return { ...STORE_IDENTITY, baseGeneration: 0, revision: 1, vectors, ...extra };
}

function requestFor(extra: Partial<RefRunRequest> = {}): RefRunRequest {
  return { ref: "refs/heads/main", ...extra };
}

// Behaviour: a complete run opens exactly one attempt, hands every manifest entry to the
// store as a part and finalises the attempt once, with no abandonment behind it. The one
// deletion it publishes is the path the store says it still serves; the request names no
// prior tree, so only the store's answer can produce that tombstone.
test("a complete run opens one attempt, submits every manifest entry and finalizes once", async () => {
  const files = { "README.md": "# demo\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ present: ["src/removed.ts"] });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  assert.equal(result.layer, null);
  assert.equal(result.generation, 1);
  assert.equal(result.receiptDigest, RECEIPT_DIGEST);
  assert.equal(calls.manifests.length, 1);
  assert.equal(calls.opened.length, 1);
  assert.deepEqual(calls.parts.flatMap((call) => call.part.upserts), ["README.md", "src/a.ts", "src/b.ts"]);
  assert.deepEqual(calls.parts[0].part.tombstones, ["src/removed.ts"]);
  assert.equal(calls.finalized.length, 1);
  assert.deepEqual(calls.finalized[0].requiredPaths, ["README.md", "src/a.ts", "src/b.ts"]);
  assert.equal(calls.finalized[0].manifest.entries.length, 3);
  assert.equal(calls.opened[0].manifestDigest, calls.finalized[0].manifest.digest);
  assert.equal(calls.abandoned.length, 0);
});

// Behaviour: a ref that moved off the pinned commit is a connector refusal, so no store
// write of any kind may happen - not even an abandonment of an attempt nobody opened.
test("a stale run publishes nothing", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider, calls: providerCalls } = fakeProvider({ files, movedHead: SHA_MOVED });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.STALE_REF);
  assert.equal(result.layer, "connector");
  assert.equal(providerCalls.blobs.length, 0);
  assertNoStoreCalls(calls);
});

// Behaviour: a tree holding a path escape, a symlink and a submodule is refused with the
// connector's own violations, and nothing reaches the store.
test("an unsafe-tree run publishes nothing and reports the connector's violations", async () => {
  const tree: RefTreeEntry[] = [
    { path: "../escape.ts", type: "blob", mode: "100644" },
    { path: "docs/link.md", type: "blob", mode: "120000" },
    { path: "vendor/dep", type: "commit", mode: "160000" },
    { path: "src/a.ts", type: "blob", mode: "100644" },
  ];
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider } = fakeProvider({ files, tree });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.UNSAFE_TREE);
  assert.equal(result.layer, "connector");
  assert.deepEqual(result.violations, [
    { path: "../escape.ts", reason: "PARENT_SEGMENT" },
    { path: "docs/link.md", reason: "SYMLINK" },
    { path: "vendor/dep", reason: "SUBMODULE" },
  ]);
  assertNoStoreCalls(calls);
});

// Behaviour: a run whose blob fetch failed covers only part of the tree, so it publishes
// nothing and reports the connector's failure text.
test("an incomplete-tree run publishes nothing", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider } = fakeProvider({ files, failBlob: "src/b.ts" });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.INCOMPLETE_TREE);
  assert.equal(result.layer, "connector");
  assert.match(result.failure ?? "", /src\/b\.ts/);
  assertNoStoreCalls(calls);
});

// Behaviour: when the store throws while a part is being submitted, the opened attempt is
// abandoned and no finalize is attempted, so no half-open generation is left behind.
test("a failure while submitting parts abandons the open attempt and does not finalize", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "src/c.ts": "export const c = 3;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ failPartNo: 2 });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files)), { partSize: 1 }),
    store,
  });

  assert.equal(result.code, RUN_CODE.STORE_FAILED);
  assert.equal(result.layer, "store");
  assert.equal(result.abandoned, true);
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.parts.length, 2);
  assert.equal(calls.finalized.length, 0);
  assert.deepEqual(calls.abandoned, [STORE_IDENTITY]);
});

// Behaviour: a refusal decided by the store's own fence after an accepted upload is
// reported as a store-layer refusal carrying the store's code, distinct from the code and
// the layer a connector refusal reports.
test("a store refusal at finalize is reported as a store-layer refusal, distinct from a connector refusal", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider } = fakeProvider({ files });
  const refusedStore = fakeStore({ finalizeCode: PROMOTION_OUTCOME.SUPERSEDED_BASE });

  const refused = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store: refusedStore.store,
  });

  const staleStore = fakeStore();
  const stale = await runCommittedRef({
    provider: fakeProvider({ files, movedHead: SHA_MOVED }).provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store: staleStore.store,
  });

  assert.equal(refused.code, RUN_CODE.STORE_REFUSED);
  assert.equal(refused.layer, "store");
  assert.equal(refused.storeCode, PROMOTION_OUTCOME.SUPERSEDED_BASE);
  assert.equal(refused.abandoned, true);
  assert.notEqual(stale.layer, refused.layer);
  assert.notEqual(stale.code, refused.code);
  assert.equal(stale.code, REF_RUN_OUTCOME.STALE_REF);
  // The stale branch proves the two layers differ by its answer alone, so this test also
  // has to show its store stayed untouched; otherwise a "distinct code" assertion would
  // pass while the refused run published into its own store.
  assertNoStoreCalls(staleStore.calls);
});

// Behaviour: PUBLISHED is the store's claim that the generation is searchable, so the answer has to
// carry the materialisation it documents. A store that answers PUBLISHED without it has written path
// rows nothing can return, so the run refuses instead of reporting a search that cannot work: the
// attempt it opened is abandoned after the answer, and no generation or receipt is reported.
test("a PUBLISHED answer without materialisation evidence is refused", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ omitMaterialise: true });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.STORE_REFUSED);
  assert.equal(result.layer, "store");
  assert.equal(result.storeCode, STORE_REPLY.PUBLISHED);
  assert.match(result.failure ?? "", /materialis/);
  assert.equal(result.generation, undefined);
  assert.equal(result.receiptDigest, undefined);
  assert.equal(result.abandoned, true);
  assert.equal(calls.finalized.length, 1);
  assert.deepEqual(calls.abandoned, [STORE_IDENTITY]);
});

// Behaviour: evidence that accounts for fewer paths than the run submitted is not evidence for this
// publication. A store that claims it materialised nothing while the manifest names a path is
// refused exactly as an answer with no evidence at all, so the zeroes that are honest for an empty
// tree cannot be used to publish a tree nothing can find.
test("materialisation evidence that covers fewer paths than the manifest is refused", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ materialiseAs: { reused: 0, created: 0, chunks: 0 } });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.STORE_REFUSED);
  assert.equal(result.layer, "store");
  assert.equal(result.storeCode, STORE_REPLY.PUBLISHED);
  assert.equal(result.abandoned, true);
  assert.equal(calls.finalized[0].manifest.entries.length, 2);
  assert.deepEqual(calls.abandoned, [STORE_IDENTITY]);
});

// Behaviour: a count that is not a whole, non-negative number is not a report of chunks written.
// NaN and a negative count are refused even when the path counts add up, so "an explicit zero" is
// the only zero a publication may claim and an unreadable number cannot pass as evidence.
test("materialisation counts that are not whole non-negative numbers are refused", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider } = fakeProvider({ files });
  const context = contextFor(vectorsFor(Object.keys(files)));

  const notANumber = await runCommittedRef({
    provider,
    request: requestFor(),
    context,
    store: fakeStore({ materialiseAs: { reused: 1, created: 0, chunks: Number.NaN } }).store,
  });
  const negative = await runCommittedRef({
    provider,
    request: requestFor(),
    context,
    store: fakeStore({ materialiseAs: { reused: 1, created: 0, chunks: -1 } }).store,
  });

  assert.equal(notANumber.code, RUN_CODE.STORE_REFUSED);
  assert.equal(notANumber.layer, "store");
  assert.equal(negative.code, RUN_CODE.STORE_REFUSED);
  assert.equal(negative.layer, "store");
});

// Behaviour: a replayed attempt was opened and published by an earlier run of the same declaration,
// so this call materialised nothing again and store.ts answers that publication without an outcome
// (settledPublication). That is the replay contract rather than a missing claim, so the run reports
// the publication the earlier run made and abandons nothing.
test("a replayed attempt answers the publication it already made without materialising again", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ openCode: STORE_REPLY.ATTEMPT_REPLAYED, omitMaterialise: true });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  assert.equal(result.layer, null);
  assert.equal(result.receiptDigest, RECEIPT_DIGEST);
  assert.equal(result.abandoned, false);
  assert.equal(calls.finalized.length, 1);
  assert.equal(calls.abandoned.length, 0);
});

// Behaviour: a manifest larger than one part is submitted in bounded chunks whose sizes
// never exceed the requested bound, and the attempt declares exactly that part count.
test("parts are submitted in bounded chunks", async () => {
  const files = { "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n", "d.ts": "d\n", "e.ts": "e\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files)), { partSize: 2 }),
    store,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  assert.equal(calls.opened[0].partCount, 3);
  assert.deepEqual(calls.parts.map((call) => call.partNo), [1, 2, 3]);
  assert.deepEqual(calls.parts.map((call) => call.part.upserts.length), [2, 2, 1]);
  assert.deepEqual(calls.parts.flatMap((call) => call.part.upserts), ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  assert.equal(calls.finalized[0].manifest.entries.length, 5);
});

// Behaviour: a complete tree whose path has no usable embedding cannot describe a
// searchable generation, so the run refuses before the store is asked to open anything.
test("a manifest path without a usable embedding publishes nothing", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(["src/a.ts"])),
    store,
  });

  assert.equal(result.code, RUN_CODE.MISSING_EMBEDDING);
  assert.equal(result.layer, "input");
  assertNoStoreCalls(calls);
});

// Behaviour: a refused open means this run never opened an attempt, so it must not abandon
// one - the attempt id can belong to another writer that is still uploading.
test("a refused open abandons nothing", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ openCode: STORE_REPLY.ATTEMPT_CONFLICT });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.STORE_REFUSED);
  assert.equal(result.layer, "store");
  assert.equal(result.storeCode, STORE_REPLY.ATTEMPT_CONFLICT);
  assert.equal(result.abandoned, false);
  assert.equal(calls.parts.length, 0);
  assert.equal(calls.finalized.length, 0);
  assert.equal(calls.abandoned.length, 0);
});

// Behaviour: a part the store refuses with a code (not an exception) also abandons the open
// attempt, so a refused upload cannot stay open for a finalize that would never accept it.
test("a part the store refuses abandons the open attempt and does not finalize", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ refusePartNo: 2 });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files)), { partSize: 1 }),
    store,
  });

  assert.equal(result.code, RUN_CODE.STORE_REFUSED);
  assert.equal(result.layer, "store");
  assert.equal(result.storeCode, STORE_REPLY.PART_CONFLICT);
  assert.equal(result.abandoned, true);
  assert.equal(calls.finalized.length, 0);
  assert.deepEqual(calls.abandoned, [STORE_IDENTITY]);
});

// Behaviour: a complete tree with no files still declares exactly one part, so the attempt
// stays inside the store's part range instead of opening an attempt with nothing to submit.
test("an empty tree declares one part and publishes it", async () => {
  const { provider } = fakeProvider({ files: {} });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(new Map()),
    store,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0].partCount, 1);
  assert.equal(calls.parts.length, 1);
  assert.deepEqual(calls.parts[0].part, { upserts: [], tombstones: [] });
  assert.equal(calls.finalized.length, 1);
});

// Behaviour: what the store publishes is the prior tree, so a path it still serves and the new
// tree no longer names is a real deletion: it reaches the store as a tombstone the receipt
// records, and the publication succeeds instead of being refused as an undeclared drop.
test("a tree that drops a published path declares it as a deletion and publishes", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ present: ["src/a.ts", "src/b.ts", "src/c.ts"] });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  assert.equal(result.layer, null);
  assert.equal(calls.opened.length, 1);
  assert.deepEqual(calls.parts.flatMap((call) => call.part.tombstones), ["src/c.ts"]);
  // The requirement names what the publication keeps: a declared deletion is not required,
  // because the fence refuses a required path its manifest does not carry.
  assert.deepEqual(calls.finalized[0].requiredPaths, ["src/a.ts", "src/b.ts"]);
  assert.equal(calls.finalized.length, 1);
  assert.equal(calls.abandoned.length, 0);
});

// Behaviour: a one-path tree against a three-path scope is not published as if it were the whole
// tree. The two paths the store still publishes and the tree no longer names are declared by path
// in the tombstone list, so the fence and the receipt see the drop instead of it vanishing
// silently, and the run succeeds because nothing was left unaccounted for.
test("a one-path tree against a three-path scope declares the other two as deletions", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ present: ["src/a.ts", "src/b.ts", "src/c.ts"] });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  assert.deepEqual(calls.parts[0].part.tombstones, ["src/b.ts", "src/c.ts"]);
  assert.deepEqual(calls.finalized[0].requiredPaths, ["src/a.ts"]);
});

// Behaviour: a run cannot check its manifest against a tree it cannot read, and guessing that
// nothing is published would turn the coverage requirement back into a restatement of the
// manifest. The run refuses before it pins the ref, so no attempt is opened and no part written.
test("a store that cannot report its published tree refuses the run", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider, calls: providerCalls } = fakeProvider({ files });
  const { store, calls } = fakeStore({ blind: true });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.PRIOR_TREE_UNKNOWN);
  assert.equal(result.layer, "store");
  assert.match(result.failure ?? "", /cannot report/);
  assert.equal(providerCalls.resolved.length, 0);
  assertNoStoreCalls(calls);
});

// Behaviour: a store that answers something other than its published tree - here a scope it does
// not serve - leaves the prior tree unknown too, and the run reports the store's own code rather
// than publishing with an empty deletion set.
test("a store that answers a refusal instead of its published tree refuses the run", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider, calls: providerCalls } = fakeProvider({ files });
  const { store, calls } = fakeStore({ presentCode: STORE_REPLY.SCOPE_NOT_FOUND });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.PRIOR_TREE_UNKNOWN);
  assert.equal(result.layer, "store");
  assert.equal(result.storeCode, STORE_REPLY.SCOPE_NOT_FOUND);
  assert.equal(calls.manifests.length, 1);
  assert.equal(providerCalls.resolved.length, 0);
  assertNoStoreCalls(calls);
});

// Behaviour: a scope that has never published answers "no generation", which is a fact about the
// tree and not a failure: the first run of a scope publishes with nothing to delete and nothing
// to require beyond its own manifest.
test("a scope that has never published runs with no prior tree", async () => {
  const files = { "src/a.ts": "export const a = 1;\n" };
  const { provider } = fakeProvider({ files });
  const { store, calls } = fakeStore({ presentCode: STORE_REPLY.NO_GENERATION_PUBLISHED });

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  assert.deepEqual(calls.parts[0].part.tombstones, []);
  assert.deepEqual(calls.finalized[0].requiredPaths, ["src/a.ts"]);
});

// Behaviour: the content the manifest scan already read is the content materialisation gets, so a
// publication becomes searchable without fetching a single blob twice: one read per path in the
// whole run, and every chunk of every path is prepared inside the store's publication.
test("a complete run materialises every path from the content the scan already read", async () => {
  const files = { "README.md": "# demo\n", "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider, calls: providerCalls } = fakeProvider({ files });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  // One fetch per blob for the whole run: the digest and the chunk text come from the same read.
  assert.deepEqual([...providerCalls.blobs].sort(), ["README.md", "src/a.ts", "src/b.ts"]);
  assert.equal(calls.materialised.length, 1);
  const materialised = calls.materialised[0];
  assert.deepEqual(materialised.prepared.pending.map((entry) => entry.path), ["README.md", "src/a.ts", "src/b.ts"]);
  assert.deepEqual(materialised.prepared.pending.map((entry) => entry.content), [
    "# demo\n",
    "export const a = 1;\n",
    "export const b = 2;\n",
  ]);
  assert.equal(materialised.prepared.reuse.length, 0);
  // Every pending chunk carries a vector semantic search can read, or the row would be unfindable.
  const chunks = materialised.prepared.pending.flatMap((entry) => entry.chunks);
  assert.ok(chunks.length >= 3, "every path contributes at least one chunk");
  assert.ok(chunks.every((chunk) => chunk.vector.length === EMBEDDING_DIMENSIONS));
});

// Behaviour: a blob the pinned commit no longer serves cannot become searchable text, so the
// publication is refused and the attempt that opened is abandoned - an unsearchable row would be
// invisible to every later search while the receipt claimed the path was published.
test("a blob that cannot be re-read refuses the publication instead of publishing it unsearchable", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider } = fakeProvider({ files, failBlobReread: "src/b.ts" });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
    // Nothing is retained between the scan and materialisation, so every path is fetched again
    // and this is the read that fails.
    contentCacheBytes: 0,
  });

  assert.equal(result.code, RUN_CODE.MATERIALISE_REFUSED);
  assert.equal(result.layer, "connector");
  assert.equal(result.materialiseCode, MATERIALISE_CODE.CONTENT_UNAVAILABLE);
  assert.equal(result.abandoned, true);
  assert.equal(result.generation, undefined, "a refused publication has no generation to serve");
  assert.equal(calls.finalized.length, 1);
  assert.deepEqual(calls.abandoned, [STORE_IDENTITY]);
});

// Behaviour: a path whose digest the published generation already embedded is not read again on
// the next run, so a republish of an unchanged tree costs no blob fetch for materialisation. The
// scan still reads every blob, because the digest it reports is computed from that read.
test("a second run with unchanged digests reads no blob for materialisation", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider, calls: providerCalls } = fakeProvider({ files });
  const { store, calls } = fakeStore();

  const first = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });
  const fetchedByFirstRun = providerCalls.blobs.length;
  const second = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
  });

  assert.equal(first.code, RUN_CODE.PUBLISHED);
  assert.equal(second.code, RUN_CODE.PUBLISHED);
  assert.equal(calls.materialised.length, 2);
  assert.equal(calls.materialised[0].reads, 2, "the first run reads both paths for their chunks");
  assert.equal(calls.materialised[1].reads, 0, "the second run reads nothing for chunks");
  assert.deepEqual(calls.materialised[1].prepared.pending, []);
  assert.deepEqual(calls.materialised[1].prepared.reuse.map((entry) => entry.path), ["src/a.ts", "src/b.ts"]);
  // The only fetches of the second run are the digests of the scan, one per blob.
  assert.equal(providerCalls.blobs.length - fetchedByFirstRun, 2);
});

// Behaviour: a budget that is not a finite byte count is not read as "unbounded". It retains
// nothing, so a caller's broken value costs an extra fetch instead of holding the whole tree in
// memory, which is the only thing the budget exists to prevent.
test("a budget that is not a finite byte count retains no blob content", async () => {
  const files = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" };
  const { provider, calls: providerCalls } = fakeProvider({ files });
  const { store, calls } = fakeStore();

  const result = await runCommittedRef({
    provider,
    request: requestFor(),
    context: contextFor(vectorsFor(Object.keys(files))),
    store,
    contentCacheBytes: Number.POSITIVE_INFINITY,
  });

  assert.equal(result.code, RUN_CODE.PUBLISHED);
  assert.equal(calls.materialised[0].reads, 2);
  // One fetch for the digest and one for the chunks of each path: nothing was retained.
  assert.deepEqual([...providerCalls.blobs].sort(), ["src/a.ts", "src/a.ts", "src/b.ts", "src/b.ts"]);
});

/**
 * The router and the administration surface build a Prisma client as they load, so the checks
 * below read the capability table those modules export instead of a row: no query runs, and the
 * URL below is only what the client needs to be constructed.
 */
async function capabilities() {
  const router = await api();
  const admin = await import("../src/api/repo-index-admin.js");
  return { CAPABILITY: router.CAPABILITY, GRANT_KINDS: admin.GRANT_KINDS };
}

/** The router itself, loaded against an address nothing reaches. */
async function api() {
  process.env.DATABASE_URL ??= "postgresql://repo-index-test:unused@127.0.0.1:1/unreachable";
  return import("../src/api/repo-index.js");
}

/** The kinds one operation accepts, as plain strings, so a missing kind is a value and not a type error. */
function kindsOf(kinds: readonly string[]): readonly string[] {
  return kinds;
}

// Behaviour: the sync worker holds a connector grant, and every operation such a worker performs
// has to accept it - declaring an attempt, writing its parts and reading the published tree it
// compares the next tree against. A kind the admin mints that no route accepts is a credential
// that answers every request GRANT_MISSING.
test("the connector grant may declare an attempt, write its parts and read the published tree", async () => {
  const { CAPABILITY } = await capabilities();

  assert.equal(kindsOf(CAPABILITY.OPEN_ATTEMPT).includes("connector"), true, "open an attempt");
  assert.equal(kindsOf(CAPABILITY.PUT_PART).includes("connector"), true, "write a part");
  assert.equal(kindsOf(CAPABILITY.READ_MANIFEST).includes("connector"), true, "read the manifest");
  assert.equal(kindsOf(CAPABILITY.READ_RECEIPT).includes("connector"), true, "read the receipt");
});

// Behaviour: a connector may not publish or abandon, because publishing is the fence's decision
// and a connector that could finalize would promote its own upload; those two stay admin-only.
test("the connector grant cannot publish or abandon", async () => {
  const { CAPABILITY } = await capabilities();

  assert.equal(kindsOf(CAPABILITY.FINALIZE).includes("connector"), false, "finalize");
  assert.equal(kindsOf(CAPABILITY.ABANDON).includes("connector"), false, "abandon");
  assert.equal(kindsOf(CAPABILITY.FINALIZE).includes("admin"), true, "finalize stays admin-only");
  assert.equal(kindsOf(CAPABILITY.ABANDON).includes("admin"), true, "abandon stays admin-only");
});

// Behaviour: the set the admin can mint and the set the router accepts are the same set, so no
// minted credential is unusable and no accepted kind can be minted twice under two names.
test("every grant kind the admin mints is accepted by at least one operation", async () => {
  const { CAPABILITY, GRANT_KINDS } = await capabilities();
  const accepted = new Set(Object.values(CAPABILITY).flatMap(kindsOf));

  for (const kind of GRANT_KINDS) assert.equal(accepted.has(kind), true, kind);
});

/** A finalize call with no grant header: the body is decided before any scope or grant is read. */
async function finalizeOverHttp(scopeId: string, body: unknown) {
  const { repoIndexRoutes } = await api();
  const url = `http://local/v1/repo-index/scopes/${scopeId}/generations/attempt-1/finalize`;
  return repoIndexRoutes.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Behaviour: the searchable demand is answered only after the caller proves a grant on this scope.
// Deciding it from the body first would answer 422 for a scope the caller holds no grant on, which
// tells a stranger what this scope's publication would accept; the answer is the same GRANT_MISSING
// any other finalize body gets, and the attempt stays untouched.
test("a searchable demand is answered only after the caller proves a grant", async () => {
  const response = await finalizeOverHttp("scope-1", {
    requiredPaths: [],
    manifest: { digest: "digest-1", dimensions: EMBEDDING_DIMENSIONS, entries: [] },
    searchable: true,
  });

  assert.equal(response.status, 403);
  const body = (await response.json()) as any;
  assert.equal(body.success, false);
  assert.equal(body.error.code, "GRANT_MISSING");
});
