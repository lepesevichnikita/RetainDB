/**
 * The committed-ref connector over a REAL repository: this worktree at one pinned commit.
 *
 * Every other test of this pipeline builds a two-or-three-file repository in a temporary
 * directory. Those fixtures prove the shape of the answers; they cannot say what the connector
 * does with a tree nobody wrote for it: hundreds of files, a lock file, migrations, generated
 * bundles and blobs far larger than anything a fixture carries. This file indexes
 * `git rev-parse HEAD` of the worktree it lives in and nothing else, and it never writes to it.
 *
 * The chain it drives, unmodified:
 *
 *   this worktree's git object store
 *     -> createGitRefProvider (resolve the commit, enumerate its tree, read every blob)
 *     -> readCommittedRef (pin, enumerate, digest, refuse an incomplete or unsafe tree)
 *     -> runCommittedRef (open one attempt, submit its parts, finalize it)
 *     -> the real store's publish transaction (fence, generation, path rows, materialisation)
 *
 * Two seams are supplied by the test, and every write still goes through store.ts:
 *
 * - `CommittedRefContext.vectors` is the embedding stage's output. It is a stable 1024-dimension
 *   pseudo-vector derived from each blob's digest (receipt.ts:148 requires a usable vector for
 *   every manifest path), so the run measures ENUMERATION AND PUBLICATION and no model is called.
 * - `CommittedRefRun.store` wraps the real store's own functions to record the manifest each run
 *   declares and to pass the `embed` option `FinalizeInput` declares, so materialisation would
 *   embed chunk text with a deterministic pseudo-vector instead of reaching for a model.
 *
 * What this file found at the pinned commit, and therefore asserts: the tree reads COMPLETE
 * (hundreds of paths, megabytes of blobs, no unsafe entry), and at the DOCUMENTED DEFAULT ceiling
 * the run REFUSES with MATERIALISE_REFUSED / CHUNK_LIMIT, because the tree materialises to more
 * searchable chunks than `MATERIALISE_LIMITS.maxChunksPerGeneration` allows. Nothing is published.
 * The cases whose premise is "the default refuses" delete `MATERIALISE_MAX_CHUNKS_ENV` for their
 * duration and restore it afterwards, so the premise holds whatever the ambient environment exports.
 *
 * With the variable raised above the tree's plan the ceiling is no longer the obstacle, and the last
 * two cases say what happens instead: the run no longer refuses at the ceiling, and the tree
 * publishes end to end - staged in bounded transactions, promoted in one - after which a search
 * through the production retriever returns a path git itself lists.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createGitRefProvider } from "../src/connectors/ref-provider-git.js";
import { REF_RUN_OUTCOME, readCommittedRef, type RefManifestEntry } from "../src/connectors/repo-ref.js";
import { chunkText } from "../src/engine/chunker.js";
import { RUN_CODE, runCommittedRef, type CommittedRefRunResult, type PublicationStore } from "../src/engine/repo-index/connector-run.js";
import { MATERIALISE_CODE, MATERIALISE_LIMITS, MATERIALISE_MAX_CHUNKS_ENV, type Embedder } from "../src/engine/repo-index/materialise.js";
import { EMBEDDING_DIMENSIONS } from "../src/engine/repo-index/receipt.js";
import type { AttemptManifest, FinalizeInput } from "../src/engine/repo-index/store.js";

/**
 * The repository this file indexes: this package's own worktree, three levels above
 * `packages/server/test`. No other checkout is read, so the evidence is attributable to a commit
 * of this repository and to no local working tree.
 */
const REPO_DIR = fileURLToPath(new URL("../../../", import.meta.url));

const databaseUrl = process.env.RETAINDB_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("RETAINDB_TEST_DATABASE_URL must name a migrated PostgreSQL database: this file publishes real generations and skips nothing");
}
process.env.DATABASE_URL = databaseUrl;
const savedEnvironment = { ...process.env };

/** Bounded so a runaway git answer fails loudly instead of growing without limit. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Wall-clock a read or a run over this repository may take. A wedged git or a held transaction
 * would otherwise hang the suite instead of failing it, so both are measured against this bound.
 */
const RUN_BUDGET_MS = 120_000;

/** Every scope row this file created, removed once the suite finishes. */
const scopeIds: string[] = [];

/** Every project row this file created, with its synthetic source, documents and chunks. */
const projectIds: string[] = [];

/** Runs git in this worktree and answers its stdout as text. */
function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: REPO_DIR, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed in ${REPO_DIR}: ${stderr.trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Runs git in this worktree and answers its raw stdout bytes, for a blob that may not be text. */
function gitBytes(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: REPO_DIR, maxBuffer: GIT_MAX_BUFFER, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed in ${REPO_DIR}: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`));
        return;
      }
      resolve(Buffer.from(stdout));
    });
  });
}

/** One blob of one commit, decoded exactly as the on-disk provider decodes it. */
async function blobAt(commit: string, path: string): Promise<string> {
  return (await gitBytes(["cat-file", "blob", `${commit}:${path}`])).toString("utf8");
}

/** The digest readCommittedRef records for one blob's text. */
function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The manifest digest a run declares, spelled as connector-run.ts spells it: one
 * `path\0digest` line per entry in manifest order. Computed here from git's own answer, so it is
 * an independent value a run's declared digest can be compared against.
 */
function manifestDigest(entries: ReadonlyArray<{ path: string; digest: string }>): string {
  return sha256Of(entries.map((entry) => `${entry.path}\u0000${entry.digest}`).join("\n"));
}

/**
 * The commit this file indexes: the worktree's HEAD, resolved once.
 *
 * It is then used as the ref itself, because a commit id is the one address that cannot move: a
 * branch pushed while the suite runs cannot turn two runs of this file into two revisions.
 */
let pinned: Promise<string> | undefined;

function pinnedCommit(): Promise<string> {
  pinned ??= git(["rev-parse", "HEAD"]).then((answer) => answer.trim());
  return pinned;
}

/** What git itself says one commit's tree holds. */
interface TreeFact {
  /** Every path of the tree, in the order git lists it. */
  paths: string[];
  /** The same tree as path plus the sha256 of the blob read back from that commit. */
  entries: RefManifestEntry[];
  /** The text of every blob at that commit, so a token can be located in the tree. */
  contents: Map<string, string>;
  /** The largest blob by git's own size column, which is the largest blob a run reads. */
  largest: { path: string; bytes: number };
  /** Every blob's size added up, from git's own size column. */
  bytes: number;
}

/** The tree of one commit, read through git plumbing rather than through the connector. */
async function treeOf(commit: string): Promise<TreeFact> {
  const listing = await git(["ls-tree", "-r", "-l", "--full-tree", commit]);
  const paths: string[] = [];
  const entries: RefManifestEntry[] = [];
  const contents = new Map<string, string>();
  let largest = { path: "", bytes: 0 };
  let bytes = 0;
  for (const line of listing.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    const size = Number(line.slice(0, tab).split(/\s+/)[3]);
    const path = line.slice(tab + 1);
    const content = await blobAt(commit, path);
    paths.push(path);
    bytes += size;
    if (size > largest.bytes) largest = { path, bytes: size };
    contents.set(path, content);
    entries.push({ path, digest: sha256Of(content) });
  }
  return { paths, entries, contents, largest, bytes };
}

/** The searchable chunks one file contributes, decided exactly as materialise.ts decides it. */
function searchableChunksOf(path: string, content: string): number {
  if (!content.trim()) return 0;
  return chunkText(content, { filePath: path }).chunks.filter((chunk) => chunk.searchable).length;
}

/**
 * The chunk burden of one tree: how many searchable chunks materialisation would plan for it, the
 * path at which the running total first crosses `ceiling`, and the running total at that path - the
 * count a refusal names. That crossing is the file the refusal names, so it is computed the same way
 * materialisation computes it - over the manifest's path order, one file at a time.
 */
async function chunkBurden(commit: string, paths: readonly string[], ceiling: number): Promise<{ total: number; crossing: string; plannedAtCrossing: number }> {
  const provider = createGitRefProvider({ repoDir: REPO_DIR });
  let total = 0;
  let crossing = "";
  let plannedAtCrossing = 0;
  for (const path of [...paths].sort()) {
    total += searchableChunksOf(path, await provider.readBlob(commit, path));
    if (crossing === "" && total > ceiling) {
      crossing = path;
      plannedAtCrossing = total;
    }
  }
  return { total, crossing, plannedAtCrossing };
}

/**
 * A stable 1024-dimension vector derived from a seed: the width chunks.embedding stores, every
 * element finite and inside [-1, 1], and no element ever exactly zero. It stands in for a model
 * embedding, so a run repeated over the same seed produces the same vector and nothing calls out.
 */
function pseudoVector(seed: string): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < EMBEDDING_DIMENSIONS; block++) {
    const bytes = createHash("sha256").update(`${seed}:${block}`, "utf8").digest();
    for (const byte of bytes) {
      if (vector.length === EMBEDDING_DIMENSIONS) break;
      // byte/255*2-1 is zero only for byte 127.5, so every element is non-zero.
      vector.push((byte / 255) * 2 - 1);
    }
  }
  return vector;
}

/** The embedding stage's output for one tree: one pseudo-vector per blob digest. */
function vectorsOf(entries: readonly RefManifestEntry[]): Map<string, number[]> {
  const vectors = new Map<string, number[]>();
  for (const entry of entries) vectors.set(entry.path, pseudoVector(entry.digest));
  return vectors;
}

/** The embedding stage, replaced by a deterministic pseudo-vector per chunk text. */
function deterministicEmbedder(): Embedder {
  return async (texts: string[]) => texts.map((text) => pseudoVector(`chunk:${text}`));
}

/**
 * A word that appears in exactly one file of the tree, with that file: the answer a search must
 * return, decided from the blobs rather than from anything a run wrote.
 *
 * The candidate is taken from a *searchable* chunk of a file - the same `chunkText` materialisation
 * chunks with, and only the chunks it stores - so it is guaranteed to sit in a stored chunk's
 * `searchContent`, and it is then verified to appear in no other file's text. A word of twelve
 * letters or more is used because a shorter one is likely to appear in prose elsewhere.
 */
async function uniqueTokenOf(tree: TreeFact): Promise<{ token: string; path: string }> {
  const wordsByPath = new Map<string, Set<string>>();
  for (const [path, content] of tree.contents) wordsByPath.set(path, new Set(content.match(/[A-Za-z][A-Za-z]{11,}/g) ?? []));
  for (const [path, content] of tree.contents) {
    for (const chunk of chunkText(content, { filePath: path }).chunks) {
      if (!chunk.searchable) continue;
      for (const token of new Set(chunk.content.match(/[A-Za-z][A-Za-z]{11,}/g) ?? [])) {
        const holders = [...wordsByPath].filter(([, words]) => words.has(token)).map(([holder]) => holder);
        if (holders.length === 1 && holders[0] === path) return { token, path };
      }
    }
  }
  throw new Error("this tree holds no word unique to one file, so a search cannot be asserted to name one path");
}

/**
 * The production search for published content: `retrieve`, the call POST /v1/context/query makes,
 * with its lexical half only (`useVector: false`). The published chunk vectors are a deterministic
 * pseudo-vector here, so a vector query would answer from a space nothing was embedded into; the
 * text of the chunk is what decides this answer, and every hit carries the repository path the
 * materialiser wrote into its metadata.
 */
async function searchPaths(projectId: string, query: string): Promise<Array<{ path: string; content: string }>> {
  const { retrieve } = await import("../src/engine/retriever.js");
  const answer = await retrieve({
    projectId,
    query,
    retrievalProfile: "legacy",
    useCache: false,
    useVector: false,
    hybridSearch: true,
    topK: 5,
    threshold: 0,
    rerank: false,
    compress: false,
  });
  return answer.results.map((entry: { metadata?: Record<string, unknown>; content?: string }) => ({
    path: String(entry.metadata?.repo_path ?? ""),
    content: String(entry.content ?? ""),
  }));
}

/**
 * The real store, entry for entry. It is the dependency `runCommittedRef` takes, so this is where
 * a caller supplies the options the run does not carry; every function below is store.ts's own.
 * `finalizeAttempt` records the manifest the run declared and forwards store.ts's `embed` option,
 * which materialisation takes its chunk vectors from and connector-run.ts does not pass.
 */
async function realStore(manifests: AttemptManifest[]): Promise<PublicationStore> {
  const store = await import("../src/engine/repo-index/store.js");
  return {
    openAttempt: store.openAttempt,
    putPart: store.putPart,
    abandonAttempt: store.abandonAttempt,
    readManifest: store.readManifest,
    finalizeAttempt: (input: FinalizeInput) => {
      manifests.push(input.manifest);
      return store.finalizeAttempt({ ...input, embed: deterministicEmbedder() });
    },
  };
}

/** One active scope with its own project, which a publication would attribute its rows to. */
async function fixtureScope() {
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  const name = `repo-index-realrepo-${randomUUID()}`;
  const commit = await pinnedCommit();
  const project = await client.project.create({ data: { name, slug: name, orgId: "default" } });
  projectIds.push(project.id);
  const scope = await client.repoIndexScope.create({
    data: {
      projectId: project.id,
      repoHost: "git.example.invalid",
      repoExternalId: `repo-${name}`,
      worktreePath: REPO_DIR,
      deviceId: `device-${name}`,
      ref: commit,
      headCommit: commit,
      policyVersion: "policy-1",
      pipelineVersion: "pipeline-1",
    },
  });
  scopeIds.push(scope.id);
  return { client, project, scope };
}

/**
 * One committed-ref run of this worktree's pinned commit, through the real store, timed.
 * A run that throws fails the test that awaited it: the connector's answers are values, so an
 * exception here would itself be the finding.
 */
async function runOverRepository(options: { scopeId: string; vectors: ReadonlyMap<string, number[]>; manifests: AttemptManifest[] }): Promise<{ result: CommittedRefRunResult; elapsedMs: number }> {
  const { db } = await import("../src/db/index.js");
  const scope = await (db as any).repoIndexScope.findUniqueOrThrow({ where: { id: options.scopeId } });
  const store = await realStore(options.manifests);
  const started = Date.now();
  const result = await runCommittedRef({
    provider: createGitRefProvider({ repoDir: REPO_DIR }),
    request: { ref: await pinnedCommit() },
    context: {
      scopeId: options.scopeId,
      attemptId: randomUUID(),
      // The fence compares these against the scope at publish time, so they are the values the
      // caller observed: a scope that has never published is generation 0, and this is revision 1.
      baseGeneration: scope.activeGeneration,
      revision: scope.activeGeneration + 1,
      vectors: options.vectors,
    },
    store,
  });
  return { result, elapsedMs: Date.now() - started };
}

/**
 * Deletes `MATERIALISE_MAX_CHUNKS_ENV` and answers the call that puts the process's own value back.
 *
 * The cases that follow assert that the DOCUMENTED DEFAULT refuses this tree. The code under test
 * reads the variable when a generation is chunked, so an ambient value - an operator's own `50000`,
 * exported while running this file - would be measured instead of the default: the refusal would
 * become a publication, or a transaction that outran its budget, and the assertion would be about
 * the environment rather than about the default. Pinning it makes the premise explicit; the caller
 * hands the answer to `t.after`, so the restore happens even when an assertion fails first.
 */
function pinDefaultCeiling(): () => void {
  const saved = process.env[MATERIALISE_MAX_CHUNKS_ENV];
  delete process.env[MATERIALISE_MAX_CHUNKS_ENV];
  return () => {
    if (saved === undefined) delete process.env[MATERIALISE_MAX_CHUNKS_ENV];
    else process.env[MATERIALISE_MAX_CHUNKS_ENV] = saved;
  };
}

/** Every table this file writes to, counted for the rows it created. */
async function countsOf(client: any) {
  return {
    scopes: await client.repoIndexScope.count({ where: { id: { in: scopeIds } } }),
    generations: await client.repoIndexGeneration.count({ where: { scopeId: { in: scopeIds } } }),
    parts: await client.repoIndexPart.count({ where: { generation: { scopeId: { in: scopeIds } } } }),
    paths: await client.repoIndexPath.count({ where: { scopeId: { in: scopeIds } } }),
    projects: await client.project.count({ where: { id: { in: projectIds } } }),
    sources: await client.source.count({ where: { projectId: { in: projectIds } } }),
    documents: await client.document.count({ where: { projectId: { in: projectIds } } }),
    chunks: await client.chunk.count({ where: { projectId: { in: projectIds } } }),
  };
}

// Behaviour: the connector reads this repository's pinned commit completely. Every path git
// reports is in the manifest with the digest of the blob at that commit, no path is invented, no
// entry is refused, and a second independent provider answers the very same manifest. This is the
// enumeration half: it is what makes the run's later refusal a statement about the tree's size
// rather than about a tree the connector could not read.
test("the connector reads this repository at its pinned commit, completely and deterministically", async () => {
  const commit = await pinnedCommit();
  const tree = await treeOf(commit);

  const started = Date.now();
  const first = await readCommittedRef(createGitRefProvider({ repoDir: REPO_DIR }), { ref: commit });
  const elapsedMs = Date.now() - started;

  // A coarse bound, so the test cannot silently become an empty tree: this repository holds
  // hundreds of files and megabytes of blobs. Measured: 309 paths, 3,308,357 bytes.
  assert.ok(tree.paths.length > 100, `the pinned commit holds a real tree, got ${tree.paths.length} paths`);
  assert.ok(tree.bytes > 1_000_000, `the pinned commit holds real blobs, got ${tree.bytes} bytes`);
  assert.ok(elapsedMs < RUN_BUDGET_MS, `the read finished inside its budget, took ${elapsedMs}ms`);

  // The whole tree, read cleanly: no unsafe entry, nothing skipped, nothing refused.
  assert.equal(first.outcome, REF_RUN_OUTCOME.COMPLETE, `the tree must read cleanly: ${first.failure}`);
  assert.equal(first.complete, true, "a complete read is the only one that may reach the store");
  assert.equal(first.failure, null);
  assert.deepEqual(first.violations, [], "this commit holds no symlink, submodule or unknown mode");
  assert.equal(first.commit, commit);

  // The path set is git's own, path for path and digest for digest.
  assert.deepEqual(first.manifest.map((entry) => entry.path), tree.paths, "the manifest is the tree git reports");
  assert.deepEqual(first.manifest, tree.entries, "every digest is the sha256 of that commit's blob");

  // Determinism of the read itself: a second provider instance, independent of the first.
  const second = await readCommittedRef(createGitRefProvider({ repoDir: REPO_DIR }), { ref: commit });
  assert.equal(second.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.deepEqual(second.manifest, first.manifest, "two reads of one commit answer one manifest");
  assert.equal(manifestDigest(second.manifest), manifestDigest(first.manifest), "and one manifest digest");

  // Scale, recorded rather than assumed: the largest blob read is git's own largest.
  assert.ok(tree.largest.bytes > 100_000, `the tree holds a blob above 100 KB, largest is ${tree.largest.bytes} bytes`);
  assert.ok(
    first.manifest.some((entry) => entry.path === tree.largest.path),
    `the largest blob ${tree.largest.path} is in the manifest`,
  );
  assert.equal(Buffer.byteLength(await blobAt(commit, tree.largest.path), "utf8"), tree.largest.bytes, "and was read at its full size");
});

// Behaviour: a committed-ref run of this repository refuses at materialisation and publishes
// nothing. The connector's read is complete, the embedding seam answers a usable vector for every
// path, the attempt opens and its parts are accepted - and the publish transaction then rolls
// back, because this tree needs more searchable chunks than MATERIALISE_LIMITS allows. The scope
// stays at generation 0 with no path row, no document and no chunk.
test("a committed-ref run over this repository refuses at materialisation and publishes nothing", async (t) => {
  // The premise of this case is the documented default, so the variable is pinned rather than
  // inherited: the operator who raised the ceiling for their own deployment must not be able to
  // turn this assertion into a publication (or into the transaction time that follows one).
  t.after(pinDefaultCeiling());
  const commit = await pinnedCommit();
  const tree = await treeOf(commit);
  const burden = await chunkBurden(commit, tree.paths, MATERIALISE_LIMITS.maxChunksPerGeneration);
  const { client, project, scope } = await fixtureScope();
  const manifests: AttemptManifest[] = [];
  const vectors = vectorsOf(tree.entries);

  // The seam this file supplies: 1024 finite, non-zero floats per blob digest, no model called.
  assert.equal(vectors.size, tree.entries.length, "one vector per manifest path");
  for (const vector of vectors.values()) {
    assert.equal(vector.length, EMBEDDING_DIMENSIONS);
    assert.ok(vector.every((value) => Number.isFinite(value) && value !== 0), "every element is finite and non-zero");
  }

  const { result, elapsedMs } = await runOverRepository({ scopeId: scope.id, vectors, manifests });

  // Never a hang, and never an unhandled throw: the run answered a value inside its budget.
  assert.ok(elapsedMs < RUN_BUDGET_MS, `the run finished inside its budget, took ${elapsedMs}ms`);
  assert.equal(result.code, RUN_CODE.MATERIALISE_REFUSED, "the publish transaction rolled back on content, it did not fail");
  assert.equal(result.layer, "input", "the tree's size is the caller's input, not a connector or store failure");
  assert.equal(result.materialiseCode, MATERIALISE_CODE.CHUNK_LIMIT, "the documented ceiling stopped the materialisation");
  assert.equal(result.commit, commit, "the refusal names the commit it read");

  // Why: this tree plans for more searchable chunks than one generation may materialise, and the
  // refusal names the file at which the running total crossed the ceiling, the plan by that file,
  // the ceiling in force and the variable that decides it.
  assert.ok(
    burden.total > MATERIALISE_LIMITS.maxChunksPerGeneration,
    `the tree plans ${burden.total} searchable chunks against a ${MATERIALISE_LIMITS.maxChunksPerGeneration} ceiling`,
  );
  assert.equal(
    result.failure,
    `${MATERIALISE_CODE.CHUNK_LIMIT}: ${burden.crossing}: planned ${burden.plannedAtCrossing} chunks so far - ${burden.plannedAtCrossing} new, 0 reused - exceeding the ${MATERIALISE_LIMITS.maxChunksPerGeneration}-chunk ceiling set by ${MATERIALISE_MAX_CHUNKS_ENV} (unset, documented default)`,
    "the refusal names the crossing file, the plan so far, the ceiling in force and the variable that sets it",
  );

  // The attempt did reach the store: one part was submitted before the transaction refused it.
  assert.ok(result.partCount >= 1, `the run submitted ${result.partCount} part(s) before the refusal`);
  assert.equal(result.abandoned, true, "the attempt it opened was abandoned, so no half-open generation survives");
  assert.equal(result.generationId, undefined, "nothing was published, so there is no generation to point at");
  assert.equal(result.storeCode, null, "no store code decided this refusal");
  assert.equal(result.receiptDigest, undefined);

  // Nothing is published: the scope still serves no generation, and no path row belongs to it.
  const scopeAfter = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
  assert.equal(scopeAfter.activeGeneration, 0, "the scope was never moved onto a generation");
  assert.equal(await client.repoIndexPath.count({ where: { scopeId: scope.id } }), 0, "the manifest's path rows rolled back");

  // The attempt row is the one trace left: open was not a publication, so it is abandoned.
  assert.equal(manifests.length, 1, "the run declared exactly one manifest, which is what it tried to publish");
  const generations = await client.repoIndexGeneration.findMany({ where: { scopeId: scope.id } });
  assert.equal(generations.length, 1);
  assert.equal(generations[0].status, "abandoned");
  assert.equal(generations[0].publishedAt, null);
  assert.equal(generations[0].receiptDigest, null);
  assert.equal(generations[0].manifestDigest, manifests[0].digest, "the abandoned row keeps the digest the run declared");
  assert.equal(manifests[0].digest, manifestDigest(tree.entries), "and that digest describes the tree git reports");

  // Everything before the ceiling worked at full scale: the store accepted every part, and the
  // parts describe the whole tree rather than a prefix of it. The refusal is the ceiling alone.
  const parts = await client.repoIndexPart.findMany({ where: { generationId: generations[0].id } });
  assert.equal(parts.length, result.partCount, "every part the run declared was accepted");
  assert.equal(
    parts.reduce((total: number, part: any) => total + part.upsertCount, 0),
    manifests[0].entries.length,
    "the accepted parts describe every path of the tree",
  );
  assert.equal(parts.reduce((total: number, part: any) => total + part.tombstoneCount, 0), 0, "a first publication deletes nothing");

  // The materialisation wrote nothing either: its source, documents and chunks rolled back with
  // the seal, so a refused publication leaves no searchable row behind.
  assert.equal(await client.source.count({ where: { projectId: project.id } }), 0, "the scope's synthetic source rolled back");
  assert.equal(await client.document.count({ where: { projectId: project.id } }), 0);
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), 0);
});

// Behaviour: two independent runs of the same pinned commit - two scopes, two provider instances,
// two attempts - declare the same manifest digest and the same path set, and that digest is the
// digest of the tree git reports. Without a forge this is the closest thing to two devices
// retrieving one revision: the answer is a property of the commit, not of the run.
test("two independent runs of the same pinned commit declare the same manifest digest and path set", async (t) => {
  // Both runs are asserted to refuse at the documented default, so the variable is pinned here too:
  // with it exported, the two runs would publish (or spend 30s each trying to) and this case would
  // be measuring the environment instead of the answer a default deployment gets.
  t.after(pinDefaultCeiling());
  const commit = await pinnedCommit();
  const tree = await treeOf(commit);
  const vectors = vectorsOf(tree.entries);
  const firstScope = await fixtureScope();
  const secondScope = await fixtureScope();
  const firstManifests: AttemptManifest[] = [];
  const secondManifests: AttemptManifest[] = [];

  const first = await runOverRepository({ scopeId: firstScope.scope.id, vectors, manifests: firstManifests });
  const second = await runOverRepository({ scopeId: secondScope.scope.id, vectors, manifests: secondManifests });

  // Both runs answer the same way, so the refusal is deterministic and not a race.
  assert.equal(first.result.code, RUN_CODE.MATERIALISE_REFUSED);
  assert.equal(second.result.code, RUN_CODE.MATERIALISE_REFUSED);
  assert.equal(first.result.materialiseCode, second.result.materialiseCode, "both refuse for the same reason");
  assert.equal(first.result.commit, commit);
  assert.equal(second.result.commit, commit);
  assert.equal(first.result.failure, second.result.failure, "and name the same file");

  // The two manifests: one digest, one path set, one digest per path.
  assert.equal(firstManifests.length, 1);
  assert.equal(secondManifests.length, 1);
  assert.equal(firstManifests[0].digest, secondManifests[0].digest, "the two runs declare the same manifest digest");
  assert.equal(firstManifests[0].dimensions, EMBEDDING_DIMENSIONS);
  assert.deepEqual(
    secondManifests[0].entries.map((entry) => entry.path),
    firstManifests[0].entries.map((entry) => entry.path),
    "the two runs declare the same path set",
  );
  assert.deepEqual(secondManifests[0].entries, firstManifests[0].entries, "and the same digest under every path");

  // The digest is a fact about the commit: recomputed from git's own blobs it is the same value,
  // and the same holds for every declared path.
  assert.equal(firstManifests[0].digest, manifestDigest(tree.entries));
  assert.equal(firstManifests[0].digest.length, 64);
  assert.deepEqual(
    firstManifests[0].entries.map((entry) => ({ path: entry.path, digest: entry.digest })),
    tree.entries,
    "every declared path and digest is the blob git holds at that commit",
  );

  // Neither run published anything, so the scope that would have served the tree still serves none.
  for (const { client, scope } of [firstScope, secondScope]) {
    const scopeAfter = await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } });
    assert.equal(scopeAfter.activeGeneration, 0);
    assert.equal(await client.repoIndexPath.count({ where: { scopeId: scope.id } }), 0);
  }
});

// Behaviour: the ceiling is configuration, not a property of this tree. The same commit, the same
// manifest, the same reader, the same embedder and the same store, with the variable raised above
// the plan, no longer refuse at CHUNK_LIMIT. What happens next is recorded rather than assumed: the
// publication either finishes inside the publish transaction's 30s budget and publishes, or the
// store answers LOCK_TIMEOUT because that budget expired. Both are asserted, so a failure to
// publish can never be read as the ceiling still refusing - and a run that stopped for any other
// reason fails this case instead of passing quietly.
test("with the ceiling raised above the plan, the same run does not refuse at the ceiling", async (t) => {
  const commit = await pinnedCommit();
  const tree = await treeOf(commit);
  const raised = 50_000;
  const burden = await chunkBurden(commit, tree.paths, raised);
  const { client, project, scope } = await fixtureScope();
  const manifests: AttemptManifest[] = [];

  // The premise: the ceiling now in force is above what this tree plans, so a CHUNK_LIMIT answer
  // would mean the configuration is not the one the run obeyed.
  assert.ok(burden.total <= raised, `the raised ceiling is above the tree's plan: ${burden.total} <= ${raised}`);
  assert.equal(burden.crossing, "", "no file of this tree crosses the raised ceiling");

  const saved = process.env[MATERIALISE_MAX_CHUNKS_ENV];
  t.after(() => {
    if (saved === undefined) delete process.env[MATERIALISE_MAX_CHUNKS_ENV];
    else process.env[MATERIALISE_MAX_CHUNKS_ENV] = saved;
  });
  process.env[MATERIALISE_MAX_CHUNKS_ENV] = String(raised);

  const { result, elapsedMs } = await runOverRepository({ scopeId: scope.id, vectors: vectorsOf(tree.entries), manifests });
  assert.ok(elapsedMs < RUN_BUDGET_MS, `the run finished inside its budget, took ${elapsedMs}ms`);

  // The ceiling is gone from the answer, whatever else happened: no CHUNK_LIMIT code, and no
  // CHUNK_LIMIT in the text an operator would read.
  assert.notEqual(result.materialiseCode, MATERIALISE_CODE.CHUNK_LIMIT, `the raised ceiling must not refuse the tree: ${JSON.stringify(result)}`);
  assert.equal(String(result.failure ?? "").includes(MATERIALISE_CODE.CHUNK_LIMIT), false, `and nothing names the ceiling: ${result.failure}`);

  if (result.code === RUN_CODE.PUBLISHED) {
    // The tree became the generation the scope serves, holding every chunk the plan measured.
    assert.equal(result.generation, 1, "the first publication is generation 1");
    assert.equal(await client.repoIndexPath.count({ where: { scopeId: scope.id } }), tree.paths.length, "every path of the tree has a row");
    assert.equal(await client.chunk.count({ where: { projectId: project.id } }), burden.total, "and the generation holds every chunk the plan measured");
    t.diagnostic(`published ${tree.paths.length} paths and ${burden.total} chunks in ${elapsedMs}ms`);
    return;
  }

  // Not the ceiling. The run got past the plan, embedded every chunk and then ran out of the publish
  // transaction's 30s budget, which the store answers as LOCK_TIMEOUT. That is a separate blocker -
  // the transaction's budget, not the configuration - and it is named here rather than passed over:
  // a tree this size is exactly the tree the variable exists to allow.
  assert.equal(result.code, RUN_CODE.STORE_REFUSED, `the run was stopped above the ceiling, by the store: ${JSON.stringify(result)}`);
  assert.equal(result.storeCode, "LOCK_TIMEOUT", "the publish transaction outran its 30s budget");
  assert.equal(result.layer, "store");
  t.diagnostic(
    `the ceiling no longer refuses this tree; the publication then hit the publish transaction's 30s budget after ${elapsedMs}ms ` +
      `(${result.code}/${result.storeCode}). That is a separate blocker - the transaction's budget, not the ceiling - and nothing was published.`,
  );
  assert.equal((await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } })).activeGeneration, 0, "a transaction that expired published nothing");
  assert.equal(await client.repoIndexPath.count({ where: { scopeId: scope.id } }), 0, "and left no path row with it");
});

// Behaviour: with the ceiling raised above the plan, this repository publishes end to end and a
// search through the production retriever returns a file git itself lists. The publication runs in
// the two phases the plan requires - the stage, in bounded transactions outside the publish one,
// and the promotion, in one short transaction - so the time is measured per phase: what used to be
// a single transaction that outran its 30s budget is now a promote that does not touch a blob.
test("with the ceiling raised above the plan, this repository publishes; the promotion is one short transaction", async (t) => {
  const raised = 50_000;
  const saved = process.env[MATERIALISE_MAX_CHUNKS_ENV];
  t.after(() => {
    if (saved === undefined) delete process.env[MATERIALISE_MAX_CHUNKS_ENV];
    else process.env[MATERIALISE_MAX_CHUNKS_ENV] = saved;
  });
  process.env[MATERIALISE_MAX_CHUNKS_ENV] = String(raised);

  const commit = await pinnedCommit();
  const tree = await treeOf(commit);
  // git's own answer, spelled the way the task that asked for this case spelled it.
  const listing = await git(["ls-tree", "-r", "--full-tree", commit]);
  const listedPaths = listing.split("\n").filter((line) => line !== "").map((line) => line.slice(line.indexOf("\t") + 1));
  const { client, project, scope } = await fixtureScope();
  const store = await import("../src/engine/repo-index/store.js");
  const provider = createGitRefProvider({ repoDir: REPO_DIR });
  const token = await uniqueTokenOf(tree);

  // 1. The connector's own read of the pinned commit, and the attempt that declares it.
  const readStarted = Date.now();
  const ref = await readCommittedRef(provider, { ref: commit });
  assert.equal(ref.outcome, REF_RUN_OUTCOME.COMPLETE, `the tree must read cleanly: ${ref.failure}`);
  const vectors = vectorsOf(ref.manifest);
  const manifest: AttemptManifest = {
    digest: manifestDigest(ref.manifest),
    dimensions: EMBEDDING_DIMENSIONS,
    entries: ref.manifest.map((entry) => ({ ...entry, vector: vectors.get(entry.path) as number[] })),
  };
  const attemptId = randomUUID();
  const partCount = Math.max(1, Math.ceil(manifest.entries.length / 500));
  const opened = await store.openAttempt({ scopeId: scope.id, attemptId, baseGeneration: 0, revision: 1, manifestDigest: manifest.digest, partCount });
  assert.equal(opened.code, "ATTEMPT_OPEN", `the attempt opens against a scope that published nothing: ${opened.code}`);
  for (let partNo = 1; partNo <= partCount; partNo++) {
    const upserts = manifest.entries.slice((partNo - 1) * 500, partNo * 500).map((entry) => entry.path);
    const part = await store.putPart({ scopeId: scope.id, attemptId, partNo, part: { upserts, tombstones: [] } });
    assert.equal(part.code, "PART_ACCEPTED", `part ${partNo} of ${partCount} is accepted: ${part.code}`);
  }
  const readMs = Date.now() - readStarted;

  // 2. The stage: every blob read, chunked and embedded outside the transaction that publishes.
  const stageStarted = Date.now();
  const staged = await store.stageAttempt({
    scopeId: scope.id,
    attemptId,
    manifest,
    readContent: (path) => provider.readBlob(commit, path),
    embed: deterministicEmbedder(),
  });
  const stagingMs = Date.now() - stageStarted;
  assert.equal(staged.code, "STAGED", `the tree stages: ${JSON.stringify(staged)}`);
  assert.ok(staged.staged, "a STAGED answer carries what it staged");
  assert.equal(staged.staged.materialise.created, tree.paths.length, "every path of the tree is staged");
  const stagedChunks = staged.staged.materialise.chunks;
  assert.ok(stagedChunks > MATERIALISE_LIMITS.maxChunksPerGeneration, `the tree is above the documented default: ${stagedChunks} chunks`);

  // Nothing staged is visible: the same search that finds the token after the promotion finds
  // nothing now, though every chunk of the tree is already in the database.
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), stagedChunks, "the stage wrote every chunk");
  assert.deepEqual(await searchPaths(project.id, token.token), [], "and no search can return any of them yet");
  assert.equal((await client.repoIndexScope.findUniqueOrThrow({ where: { id: scope.id } })).activeGeneration, 0, "the scope serves nothing");

  // 3. The promotion: the fence, the path rows, the generation bump and the flip of the stage.
  const promoteStarted = Date.now();
  const published = await store.finalizeAttempt({
    scopeId: scope.id,
    attemptId,
    requiredPaths: manifest.entries.map((entry) => entry.path),
    manifest,
    staged: staged.staged,
  });
  const promoteMs = Date.now() - promoteStarted;
  const totalMs = readMs + stagingMs + promoteMs;
  assert.ok(totalMs < RUN_BUDGET_MS, `the publication finished inside its budget, took ${totalMs}ms`);

  assert.equal(published.code, "PUBLISHED", `the tree publishes: ${JSON.stringify(published)}`);
  assert.equal(published.generation, 1, "the first publication is generation 1");
  assert.deepEqual(published.materialise, staged.staged.materialise, "the publication reports what the stage wrote");

  // 4. The served tree, path for path, against git's own listing.
  assert.equal(await client.repoIndexPath.count({ where: { scopeId: scope.id, state: "present" } }), listedPaths.length, `every path git lists has a row: ${listedPaths.length}`);
  const servedPaths = (await client.repoIndexPath.findMany({ where: { scopeId: scope.id }, select: { path: true } })).map(
    (row: { path: string }) => row.path,
  );
  // Sorted here, in one collation: the database's ORDER BY and git's byte order disagree about
  // punctuation, and this assertion is about which paths were published, not about how each sorts.
  assert.deepEqual(servedPaths.sort(), [...listedPaths].sort(), "and the rows are git's paths");
  assert.equal(await client.document.count({ where: { projectId: project.id, deletedAt: null } }), listedPaths.length, "one live document per path");
  assert.equal(await client.document.count({ where: { projectId: project.id, deletedAt: { not: null } } }), 0, "nothing is left staged");
  assert.equal(await client.chunk.count({ where: { projectId: project.id } }), stagedChunks, "the generation holds every chunk the stage wrote");

  // 5. The search: the production retriever finds the token, and every path it names is one git
  // lists verbatim. The file the token came from is among them, and the hit carries its text.
  const hits = await searchPaths(project.id, token.token);
  assert.ok(hits.length > 0, `the production search finds the published token ${token.token}`);
  for (const hit of hits) assert.ok(listedPaths.includes(hit.path), `${hit.path} is a path of the pinned commit`);
  assert.ok(hits.some((hit) => hit.path === token.path), `the file that holds ${token.token} is one of them: ${hits.map((hit) => hit.path).join(", ")}`);
  assert.ok(hits.some((hit) => hit.content.includes(token.token)), "and the answer carries the text it matched");

  t.diagnostic(
    `published ${listedPaths.length} paths and ${stagedChunks} chunks: read+declare ${readMs}ms, staged ${stagingMs}ms, ` +
      `promoted ${promoteMs}ms, ${totalMs}ms in total; "${token.token}" was found in ${token.path}`,
  );
  assert.ok(promoteMs < RUN_BUDGET_MS, `the promotion outran its budget: ${promoteMs}ms`);
});

after(async () => {
  if (!databaseUrl) return;
  const { db } = await import("../src/db/index.js");
  const client = db as any;
  try {
    // The scope owns its generations, their parts and its paths: one delete takes all of them.
    if (scopeIds.length > 0) await client.repoIndexScope.deleteMany({ where: { id: { in: scopeIds } } });
    // The synthetic source, its documents and their chunks hang off the project.
    if (projectIds.length > 0) await client.project.deleteMany({ where: { id: { in: projectIds } } });

    // Proven empty, not assumed: every table this file wrote to holds none of its rows.
    assert.deepEqual(await countsOf(client), {
      scopes: 0,
      generations: 0,
      parts: 0,
      paths: 0,
      projects: 0,
      sources: 0,
      documents: 0,
      chunks: 0,
    });
  } finally {
    await client.$disconnect();
    process.env = savedEnvironment;
  }
});
