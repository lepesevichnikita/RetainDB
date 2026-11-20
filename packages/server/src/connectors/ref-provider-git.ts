/**
 * On-disk git `RefProvider`.
 *
 * The connector decides what a ref contains; this module is the adapter that answers it from
 * a repository this process can already read, using `git` plumbing and nothing else. No
 * network, no forge credentials, no tarball and no source-profile extraction: the same
 * `RefProvider` contract later backs an HTTP adapter, so the connector keeps one publication
 * path and this file adds no second one.
 *
 * Three properties are what make a run safe to publish:
 *
 * 1. A ref is resolved to one full commit id before anything is fetched, and every later read
 *    is addressed by that id. A branch that moves mid-run therefore cannot mix two revisions
 *    into one tree: the reads keep answering the pinned commit and the connector's freshness
 *    check sees the move. Nothing is cached, because a cached resolution would report a moved
 *    branch as fresh.
 * 2. A tree is enumerated completely or not at all. A malformed record, a name that has no
 *    UTF-8 form or a truncated answer refuses the enumeration instead of returning the
 *    records that parsed as the tree, so a partial listing can never be published as full
 *    coverage.
 * 3. A blob is read from the pinned commit's own tree. The working tree, the index and the
 *    branch tip are never consulted, so a read cannot answer content from a commit the run
 *    did not pin.
 */

import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { RefEntryType, RefProvider, RefTreeEntry, RefTreePage } from "./repo-ref.js";

/** A full lowercase object id: exactly 40 hex for sha1, 64 for sha256. */
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Largest git answer this adapter reads. A listing or a blob above it is refused: an answer
 * cut off at a bound is a tree this adapter cannot vouch for.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** The entry types git itself reports; a symlink is a blob whose mode says so. */
const GIT_ENTRY_TYPE: Record<string, RefEntryType> = { blob: "blob", tree: "tree", commit: "commit" };

/** One `ls-tree -z` field separator: the tab between the header and the path bytes. */
const FIELD_SEPARATOR = 0x09;

/** One `ls-tree -z` record terminator. */
const RECORD_SEPARATOR = 0x00;

export interface GitRefProviderOptions {
  /** A work tree, a bare repository, or a `.git` directory git accepts as a repository. */
  repoDir: string;
}

/** The connector's provider, reading one on-disk repository. */
export function createGitRefProvider(options: GitRefProviderOptions): RefProvider {
  const repoDir = resolvePath(options.repoDir);
  return {
    resolveRef: (ref) => resolveRef(repoDir, ref),
    listTree: (commit, page) => listTree(repoDir, commit, page),
    readBlob: (commit, path) => readBlob(repoDir, commit, path),
  };
}

/**
 * The commit a ref names, as one full object id.
 *
 * `--end-of-options` keeps a ref that starts with a dash a revision instead of an option, and
 * `^{commit}` peels an annotated tag to the commit it tags, so the answer is always a commit
 * and never a tag or tree id. Nothing is memoised: the connector resolves the same ref again
 * to learn whether it moved, and a cached answer would report a moved branch as fresh.
 */
async function resolveRef(repoDir: string, ref: string): Promise<string> {
  let answer: string;
  try {
    answer = (await git(repoDir, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).toString("utf8").trim();
  } catch (error) {
    throw new Error(`ref ${JSON.stringify(ref)} could not be resolved in ${repoDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!COMMIT_SHA.test(answer)) {
    throw new Error(`ref ${JSON.stringify(ref)} resolved to ${JSON.stringify(answer)} in ${repoDir}, which is not a commit sha`);
  }
  return answer;
}

/**
 * The whole tree of one commit, in one page.
 *
 * `ls-tree -r -z --full-tree` walks only the tree that commit reaches and prints one NUL
 * terminated record per entry, with the git mode: a symlink and a submodule keep the mode
 * that says they are not regular files. `-r` does not descend into a gitlink, so a submodule
 * arrives as a commit entry, which is the only signal the connector has for one. Paths are
 * root relative because `--full-tree` ignores the current directory.
 *
 * `nextPage` is null only after every record parsed: an enumeration this adapter cannot
 * finish is thrown, never returned with the records that happened to parse.
 */
async function listTree(repoDir: string, commit: string, page: number): Promise<RefTreePage> {
  requireCommit("tree read", commit);
  // The tree is one page, so any other page is a caller reading a finished listing as if
  // more of it were coming; answering an empty page would look like the end of the tree.
  if (page !== 1) throw new Error(`the tree of ${commit} is one page, so page ${page} cannot be read`);
  const stdout = await git(repoDir, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  return { entries: parseTree(stdout, commit), nextPage: null };
}

/**
 * One blob's text at the pinned commit.
 *
 * `<commit>:<path>` reads the blob out of that commit's tree, so neither the working tree nor
 * the index nor the branch tip can answer for it. The path is taken literally after the first
 * colon, so a name that begins with a colon stays that file rather than becoming a revision
 * expression.
 */
async function readBlob(repoDir: string, commit: string, path: string): Promise<string> {
  requireCommit("blob read", commit);
  return (await git(repoDir, ["cat-file", "blob", `${commit}:${path}`])).toString("utf8");
}

/** Only a full object id names one immutable revision, so nothing else may address a fetch. */
function requireCommit(what: string, commit: string): void {
  if (!COMMIT_SHA.test(commit)) throw new Error(`${what} needs a full commit sha, got ${JSON.stringify(commit)}`);
}

/** Every NUL terminated record, or the failure that the listing ended mid-record. */
function parseTree(stdout: Buffer, commit: string): RefTreeEntry[] {
  const entries: RefTreeEntry[] = [];
  let start = 0;
  while (start < stdout.length) {
    const end = stdout.indexOf(RECORD_SEPARATOR, start);
    if (end < 0) throw new Error(`the tree of ${commit} ended inside a record, so it is not fully enumerated`);
    entries.push(parseEntry(stdout.subarray(start, end), commit));
    start = end + 1;
  }
  return entries;
}

/** Mode, type, object id, then the raw path bytes of one `ls-tree` record. */
function parseEntry(record: Buffer, commit: string): RefTreeEntry {
  const separator = record.indexOf(FIELD_SEPARATOR);
  if (separator <= 0) throw new Error(`the tree of ${commit} holds a record without a path: ${record.toString("latin1")}`);
  const header = record.subarray(0, separator).toString("latin1").split(" ");
  const [mode, type, object] = header;
  const entryType = GIT_ENTRY_TYPE[type];
  if (!mode || !object || !entryType) {
    throw new Error(`the tree of ${commit} holds a record this adapter cannot read: ${header.join(" ")}`);
  }
  return { path: decodePath(record.subarray(separator + 1), commit), type: entryType, mode };
}

/**
 * A path git wrote as bytes, as the string the connector contract carries.
 *
 * A name that is not valid UTF-8 has no string form. Skipping it would publish the other
 * paths as complete coverage of a tree that holds one more file, so the whole enumeration is
 * refused instead. The check is a round trip: valid UTF-8 encodes back to the same bytes.
 */
function decodePath(bytes: Buffer, commit: string): string {
  const path = bytes.toString("utf8");
  if (path === "") throw new Error(`the tree of ${commit} holds an entry with an empty path`);
  if (!Buffer.from(path, "utf8").equals(bytes)) {
    throw new Error(`the tree of ${commit} holds the path ${bytes.toString("hex")}, which is not valid UTF-8`);
  }
  return path;
}

/**
 * Runs git in the repository and answers its raw stdout bytes.
 *
 * A non-zero exit, a signal or an answer over the buffer bound rejects with git's own stderr:
 * an unreadable repository has to reach the caller as a failure, never as an empty listing it
 * could publish.
 */
function git(repoDir: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoDir, maxBuffer: GIT_MAX_BUFFER, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed in ${repoDir}: ${stderr.toString("utf8").trim() || error.message}`));
        return;
      }
      resolve(Buffer.from(stdout));
    });
  });
}
