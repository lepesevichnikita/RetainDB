/**
 * Committed-ref connector.
 *
 * Reads an approved Git ref into a manifest without a local client, hook or HTTP
 * upload: the ref is resolved to one immutable commit before any file is read, so
 * a branch that moves during the run can never mix two revisions into one manifest.
 *
 * Pure over an injected provider: no network, no database, no clock, so a refusal
 * is a value the caller can map to an HTTP or CLI answer instead of an exception.
 *
 * A ref the provider cannot resolve is not a refusal case: the run starts only for
 * an approved ref, so that failure belongs to the caller's adapter.
 */

import { createHash } from "node:crypto";

export const REF_RUN_OUTCOME = {
  /** Every blob of the pinned tree was read; the manifest may be published. */
  COMPLETE: "COMPLETE",
  /** The ref no longer points at the pinned commit, so nothing is published. */
  STALE_REF: "STALE_REF",
  /** The provider failed part way, so the tree is not full coverage. */
  INCOMPLETE_TREE: "INCOMPLETE_TREE",
  /** The tree holds an entry that cannot be read as a regular file in its root. */
  UNSAFE_TREE: "UNSAFE_TREE",
} as const;

export type RefRunOutcome = (typeof REF_RUN_OUTCOME)[keyof typeof REF_RUN_OUTCOME];

export type RefEntryType = "blob" | "tree" | "commit" | "symlink";

export type RefViolationReason =
  | "ABSOLUTE_PATH"
  | "PARENT_SEGMENT"
  | "SYMLINK"
  | "SUBMODULE"
  | "UNKNOWN_MODE"
  | "CONTROL_CHARACTER";

export interface RefTreeEntry {
  path: string;
  type: RefEntryType;
  /**
   * The git mode the provider reported. Any entry that is not a directory has to
   * report one as the string git writes: GitHub and GitLab serve a symlink or a
   * submodule as type "blob", so the mode is the only signal that the entry is not
   * a regular file. A directory may omit it, because its children are enumerated.
   */
  mode?: string;
}

export interface RefTreePage {
  entries: RefTreeEntry[];
  /** Page number to read next, or null when the tree is fully enumerated. */
  nextPage: number | null;
}

/** The provider calls a run needs, all addressable by immutable commit. */
export interface RefProvider {
  resolveRef(ref: string): Promise<string>;
  listTree(commit: string, page: number): Promise<RefTreePage>;
  readBlob(commit: string, path: string): Promise<string>;
}

export interface RefRunRequest {
  ref: string;
  /** Paths the published generation holds, so a complete run can report removals. */
  previousPaths?: readonly string[];
  /**
   * Largest blob in bytes this run may accept; a bigger one stops the run as
   * incomplete. The provider answers with content rather than a size, so the
   * bound is applied to the bytes that arrived, before they are digested. It has
   * to be a finite, non-negative count: anything else cannot bound a read, so the
   * run is refused instead of every blob passing an unanswerable comparison.
   */
  maxBlobBytes?: number;
}

export interface RefManifestEntry {
  path: string;
  digest: string;
}

export interface RefViolation {
  path: string;
  reason: RefViolationReason;
}

export interface RefRunResult {
  outcome: RefRunOutcome;
  /** The commit the ref was pinned to; empty only when the ref resolved to no sha. */
  commit: string;
  /** True only for COMPLETE, the one outcome whose manifest describes the commit. */
  complete: boolean;
  /** Empty unless COMPLETE, so a refused run cannot be published by accident. */
  manifest: RefManifestEntry[];
  /** Empty unless COMPLETE, so a refused run never signals a deletion. */
  deletions: string[];
  violations: RefViolation[];
  failure: string | null;
}

const FETCH_CONCURRENCY = 8;

/**
 * Tree pages one run may enumerate.
 *
 * Bounded because a provider that keeps announcing another page would otherwise grow the
 * manifest until memory runs out. `engine/repo-index/connector-run.ts` bounds its own paging
 * loop the same way (`PUBLISHED_PAGES_MAX`, the same number), so both loops agree on one
 * ceiling.
 */
export const TREE_PAGES_MAX = 100;

/** A commit address is a full lowercase hex object id: exactly 40 for sha1, 64 for sha256. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Read one committed ref into a manifest of relative path plus content digest.
 * The commit is pinned first, every fetch is addressed by it, and the ref is
 * re-read before and after the blob fetches so a moved branch stops the run.
 */
export async function readCommittedRef(provider: RefProvider, request: RefRunRequest): Promise<RefRunResult> {
  // A bound that cannot be honoured bounds nothing and would read every blob
  // unbounded, with NaN as the trap: every comparison against it is false. It is a
  // refusal value like the rest and is reported before the ref is pinned, so a
  // caller with a broken configuration reads nothing. The outcome is
  // INCOMPLETE_TREE because this module has no separate configuration outcome and
  // the caller already maps it to "nothing was published".
  if (request.maxBlobBytes !== undefined && !(Number.isFinite(request.maxBlobBytes) && request.maxBlobBytes >= 0)) {
    return refusal(REF_RUN_OUTCOME.INCOMPLETE_TREE, "", [], `maxBlobBytes ${request.maxBlobBytes} is not a finite non-negative byte count`);
  }

  const commit = await provider.resolveRef(request.ref);
  // Only a full object id names one immutable revision, and every later fetch is
  // addressed by it, so anything else would read a tree that can move.
  if (!COMMIT_SHA.test(commit)) {
    return refusal(REF_RUN_OUTCOME.INCOMPLETE_TREE, "", [], `ref ${request.ref} resolved to ${JSON.stringify(commit)}, which is not a commit sha`);
  }

  const tree = await readTree(provider, commit);
  if (!tree.ok) return refusal(REF_RUN_OUTCOME.INCOMPLETE_TREE, commit, [], tree.failure);

  const violations = tree.entries.map(violationOf).filter(isViolation);
  if (violations.length > 0) return refusal(REF_RUN_OUTCOME.UNSAFE_TREE, commit, violations);

  const opened = await freshness(provider, request.ref, commit);
  if (!opened.ok) return refusal(REF_RUN_OUTCOME.INCOMPLETE_TREE, commit, [], opened.failure);
  if (!opened.still) return refusal(REF_RUN_OUTCOME.STALE_REF, commit);

  const blobs = tree.entries.filter(isBlob);
  const manifest = await readManifest(provider, commit, blobs, request.maxBlobBytes);
  if (!manifest.ok) return refusal(REF_RUN_OUTCOME.INCOMPLETE_TREE, commit, [], manifest.failure);

  const closed = await freshness(provider, request.ref, commit);
  if (!closed.ok) return refusal(REF_RUN_OUTCOME.INCOMPLETE_TREE, commit, [], closed.failure);
  if (!closed.still) return refusal(REF_RUN_OUTCOME.STALE_REF, commit);

  return completed(commit, request.previousPaths, manifest.entries);
}

/** Either the whole tree or the failure that stopped it; never both. */
type TreeRead = { ok: true; entries: RefTreeEntry[] } | { ok: false; failure: string };

/** Either every blob digest or the failure that stopped them; never both. */
type ManifestRead = { ok: true; entries: RefManifestEntry[] } | { ok: false; failure: string };

async function readTree(provider: RefProvider, commit: string): Promise<TreeRead> {
  const entries: RefTreeEntry[] = [];
  const seen = new Set<string>();
  let page = 1;
  try {
    for (let read = 0; read < TREE_PAGES_MAX; read++) {
      const treePage = await provider.listTree(commit, page);
      for (const entry of treePage.entries) {
        // A repeated path would reach the publication fence as a duplicate, so the
        // manifest is refused here rather than built from two answers for one file.
        if (seen.has(entry.path)) return { ok: false, failure: `path ${entry.path} appears more than once in the tree` };
        seen.add(entry.path);
        entries.push(entry);
      }
      if (treePage.nextPage === null) return { ok: true, entries };
      // A pointer of 0, which GitLab answers for a page with nothing after it, or a
      // repeat of a page already read is refused rather than read as the end: the
      // manifest fences deletions, so treating an unnumbered page as the end would
      // publish a truncated tree as if its missing files had been removed. Only an
      // explicit null finishes the enumeration.
      if (!Number.isInteger(treePage.nextPage) || treePage.nextPage <= page) {
        return { ok: false, failure: `tree page ${page} announced next page ${treePage.nextPage}` };
      }
      page = treePage.nextPage;
    }
    // The ceiling was reached with another page still announced. The entries read so far
    // are a prefix of the tree, so the run is refused with its own failure instead of
    // finishing quietly: a prefix published as the tree would report every file in the
    // pages left unread as deleted. INCOMPLETE_TREE is the outcome for "the provider did
    // not finish", and its failure text is what tells this refusal from a broken page.
    return { ok: false, failure: `the tree of ${commit} did not finish within ${TREE_PAGES_MAX} pages` };
  } catch (error) {
    return { ok: false, failure: messageOf(error) };
  }
}

async function readManifest(
  provider: RefProvider,
  commit: string,
  blobs: RefTreeEntry[],
  maxBlobBytes: number | undefined,
): Promise<ManifestRead> {
  const entries: RefManifestEntry[] = [];
  try {
    for (let index = 0; index < blobs.length; index += FETCH_CONCURRENCY) {
      const chunk = blobs.slice(index, index + FETCH_CONCURRENCY);
      entries.push(...(await Promise.all(chunk.map((entry) => readEntry(provider, commit, entry, maxBlobBytes)))));
    }
  } catch (error) {
    return { ok: false, failure: messageOf(error) };
  }
  return { ok: true, entries: entries.sort(byPath) };
}

async function readEntry(
  provider: RefProvider,
  commit: string,
  entry: RefTreeEntry,
  maxBlobBytes: number | undefined,
): Promise<RefManifestEntry> {
  const content = await provider.readBlob(commit, entry.path);
  const bytes = Buffer.byteLength(content, "utf8");
  if (maxBlobBytes !== undefined && bytes > maxBlobBytes) {
    throw new Error(`blob ${entry.path} is ${bytes} bytes, over the ${maxBlobBytes} byte limit`);
  }
  return { path: entry.path, digest: digestOf(content) };
}

/** The ref still points at the pinned commit, or the reason the answer is unknown. */
type Freshness = { ok: true; still: boolean } | { ok: false; failure: string };

async function freshness(provider: RefProvider, ref: string, commit: string): Promise<Freshness> {
  try {
    return { ok: true, still: (await provider.resolveRef(ref)) === commit };
  } catch (error) {
    return { ok: false, failure: messageOf(error) };
  }
}

/**
 * Every entry is checked as a path and as a type, directories included: a gitlink
 * served as a directory would otherwise be dropped from the manifest without a
 * word, so no entry type may skip either check. Directories then carry no content,
 * so only their children are read.
 */
function violationOf(entry: RefTreeEntry): RefViolation | undefined {
  const badPath = pathViolation(entry.path);
  if (badPath) return badPath;
  return typeViolation(entry);
}

/**
 * A manifest path names one file inside the tree root, so it cannot be empty, use
 * a separator other than "/", start at a root, or hold a segment that names nothing
 * below the root. A path that is not inside the root is ABSOLUTE_PATH, including a
 * drive-letter prefix, which names a location outside it on a Windows host; a path
 * holding a control character cannot be a name a provider serves and is
 * CONTROL_CHARACTER; a path that walks out of or around the root is PARENT_SEGMENT.
 */
function pathViolation(path: string): RefViolation | undefined {
  if (path === "" || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\")) {
    return { path, reason: "ABSOLUTE_PATH" };
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return { path, reason: "CONTROL_CHARACTER" };
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { path, reason: "PARENT_SEGMENT" };
  }
  return undefined;
}

/**
 * A symlink leaves the root when read and a submodule is not part of this tree.
 * Providers serve both as blobs, so the git mode is the only signal that an entry
 * is not a regular file: a mode that is missing, not a string or zero padded cannot
 * show that it is one, so it is refused as UNKNOWN_MODE rather than read. A
 * directory carries no content, so its own mode is only checked for the gitlink
 * value; "040000" or no mode at all stays a working directory entry.
 */
function typeViolation(entry: RefTreeEntry): RefViolation | undefined {
  if (entry.type === "symlink" || entry.mode === "120000") return { path: entry.path, reason: "SYMLINK" };
  if (entry.type === "commit" || entry.mode === "160000") return { path: entry.path, reason: "SUBMODULE" };
  if (entry.type === "tree") return undefined;
  if (typeof entry.mode === "string" && /^[1-7][0-7]{5}$/.test(entry.mode)) return undefined;
  return { path: entry.path, reason: "UNKNOWN_MODE" };
}

function isViolation(violation: RefViolation | undefined): violation is RefViolation {
  return violation !== undefined;
}

function isBlob(entry: RefTreeEntry): boolean {
  return entry.type === "blob";
}

function byPath(left: RefManifestEntry, right: RefManifestEntry): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

function digestOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal carries the pinned commit, but no manifest and no deletion signal. */
function refusal(outcome: RefRunOutcome, commit: string, violations: RefViolation[] = [], failure: string | null = null): RefRunResult {
  return { outcome, commit, complete: false, manifest: [], deletions: [], violations, failure };
}

function completed(commit: string, previousPaths: readonly string[] | undefined, manifest: RefManifestEntry[]): RefRunResult {
  const deletions = deletionsAgainst(previousPaths, manifest);
  return { outcome: REF_RUN_OUTCOME.COMPLETE, commit, complete: true, manifest, deletions, violations: [], failure: null };
}

/** Only a complete manifest may turn a published path into a deletion. */
function deletionsAgainst(previousPaths: readonly string[] | undefined, manifest: RefManifestEntry[]): string[] {
  if (!previousPaths) return [];
  const present = new Set(manifest.map((entry) => entry.path));
  return previousPaths.filter((path) => !present.has(path)).sort();
}
