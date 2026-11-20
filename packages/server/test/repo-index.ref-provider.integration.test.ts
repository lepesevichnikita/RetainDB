import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { REF_RUN_OUTCOME, readCommittedRef, type RefProvider } from "../src/connectors/repo-ref.js";
import { createGitRefProvider } from "../src/connectors/ref-provider-git.js";

/**
 * The adapter is exercised against a real git repository on disk, never a fake: every
 * behaviour below is the answer of the `git` binary to a real object store, so a wrong
 * plumbing flag or a wrong address fails here instead of in production.
 *
 * Each test builds its own repository in the operating system's temporary directory,
 * outside the project tree, and the `after` hook removes them all.
 */

/** Bounded so a runaway listing fails loudly instead of growing without limit. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Every fixture repository this file created, removed once the suite finishes. */
const fixtureRepos: string[] = [];

/** Runs git in one fixture repository and answers its raw stdout bytes. */
function git(repo: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, maxBuffer: GIT_MAX_BUFFER, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(" ")} failed in ${repo}: ${Buffer.from(stderr).toString("utf8").trim() || error.message}`));
        return;
      }
      resolve(Buffer.from(stdout));
    });
  });
}

/** Runs git with bytes on stdin, because a tree entry name need not be valid UTF-8. */
function gitWithInput(repo: string, args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

/** A fresh repository on branch main with a local identity, so no global git config is read. */
async function newRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "retaindb-ref-provider-"));
  fixtureRepos.push(repo);
  await git(repo, ["init", "-q", "-b", "main", "."]);
  await git(repo, ["config", "user.email", "ref-provider@example.invalid"]);
  await git(repo, ["config", "user.name", "Ref Provider Test"]);
  return repo;
}

/** Writes one file of a fixture repository, creating its parent directories. */
async function write(repo: string, path: string, content: string): Promise<void> {
  const full = join(repo, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

/** Stages everything and commits it, answering the full sha of the new commit. */
async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", message]);
  return (await git(repo, ["rev-parse", "HEAD"])).toString("utf8").trim();
}

/** The digest readCommittedRef records for one blob's text. */
function digestOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** How long the stalling stub pretends git is wedged. */
const STALL_SECONDS = 2;

/**
 * Runs `call` with a `git` first on PATH that answers nothing for `STALL_SECONDS` and then
 * exits as if it had. Long enough that a deadline of a few hundred milliseconds has to be
 * what ends the call, short enough that the adapter without one still finishes and shows
 * what it answers, instead of hanging the suite.
 */
async function underStallingGit<T>(call: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "retaindb-stalling-git-"));
  try {
    const stub = join(dir, "git");
    await writeFile(stub, `#!/bin/sh\nexec sleep ${STALL_SECONDS}\n`);
    await chmod(stub, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous ?? ""}`;
    try {
      return await call();
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Behaviour: a ref answers the one full commit sha it points at right now. Nothing is
// cached, because the connector re-resolves the ref to learn whether a branch moved.
test("a ref resolves to the full commit sha it names, and re-resolves once the branch moves", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "one\n");
  const first = await commitAll(repo, "first");
  const provider = createGitRefProvider({ repoDir: repo });

  assert.match(first, /^[0-9a-f]{40}$/);
  assert.equal(await provider.resolveRef("main"), first);

  await write(repo, "a.txt", "two\n");
  const second = await commitAll(repo, "second");
  assert.notEqual(second, first);
  assert.equal(await provider.resolveRef("main"), second);
});

// Behaviour: an annotated tag names a tag object, so resolving it has to peel to the commit
// it tags. Otherwise the pinned address is a tag and the tree read is refused, or worse, a
// different revision than the one the caller approved.
test("an annotated tag resolves to the commit it tags, not to the tag object", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "tagged\n");
  const tagged = await commitAll(repo, "tagged");
  await git(repo, ["tag", "-a", "v1", "-m", "release"]);
  const tagObject = (await git(repo, ["rev-parse", "refs/tags/v1"])).toString("utf8").trim();
  await write(repo, "a.txt", "later\n");
  await commitAll(repo, "later");
  const provider = createGitRefProvider({ repoDir: repo });

  assert.notEqual(tagObject, tagged);
  assert.equal(await provider.resolveRef("v1"), tagged);
  const run = await readCommittedRef(provider, { ref: "v1" });
  assert.equal(run.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.equal(run.commit, tagged);
  assert.deepEqual(run.manifest, [{ path: "a.txt", digest: digestOf("tagged\n") }]);
});

// Behaviour: the pinned commit's whole tree is enumerated in one page with git's own
// modes, and the connector turns it into a digest per blob in sorted path order.
test("the pinned tree is enumerated with git modes and read into one digest per blob", async () => {
  const repo = await newRepo();
  await write(repo, "src/alpha.ts", "export const alpha = 1;\n");
  await write(repo, "src/nested/beta.ts", "export const beta = 2;\n");
  await write(repo, "a.txt", "a\n");
  await write(repo, "run.sh", "#!/bin/sh\n");
  await chmod(join(repo, "run.sh"), 0o755);
  const commit = await commitAll(repo, "tree");
  const provider = createGitRefProvider({ repoDir: repo });

  const page = await provider.listTree(commit, 1);
  assert.equal(page.nextPage, null);
  assert.deepEqual(
    page.entries.map((entry) => [entry.path, entry.type, entry.mode]),
    [
      ["a.txt", "blob", "100644"],
      ["run.sh", "blob", "100755"],
      ["src/alpha.ts", "blob", "100644"],
      ["src/nested/beta.ts", "blob", "100644"],
    ],
  );

  const run = await readCommittedRef(provider, { ref: "main", previousPaths: ["a.txt", "gone.ts"] });
  assert.equal(run.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.equal(run.complete, true);
  assert.equal(run.commit, commit);
  assert.deepEqual(run.manifest, [
    { path: "a.txt", digest: digestOf("a\n") },
    { path: "run.sh", digest: digestOf("#!/bin/sh\n") },
    { path: "src/alpha.ts", digest: digestOf("export const alpha = 1;\n") },
    { path: "src/nested/beta.ts", digest: digestOf("export const beta = 2;\n") },
  ]);
  // Only a complete read may declare a deletion, and this one names exactly the path
  // the pinned tree no longer holds.
  assert.deepEqual(run.deletions, ["gone.ts"]);
});

// Behaviour: every blob read is addressed by commit, so an older commit keeps answering
// its own bytes after the branch moved on, and a colon-leading name is that file's own
// blob rather than a revision expression.
test("blob content is read at the commit asked for, never at the branch tip", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "first version\n");
  await write(repo, ":(top)weird.txt", "literal colon name\n");
  const first = await commitAll(repo, "first");
  await write(repo, "a.txt", "second version\n");
  const second = await commitAll(repo, "second");
  const provider = createGitRefProvider({ repoDir: repo });

  assert.equal(await provider.readBlob(first, "a.txt"), "first version\n");
  assert.equal(await provider.readBlob(second, "a.txt"), "second version\n");
  assert.equal(await provider.readBlob(first, ":(top)weird.txt"), "literal colon name\n");
});

// Behaviour: the branch moves while the run reads blobs. The adapter re-resolves the ref
// for the closing freshness check, so the run is refused as stale instead of publishing a
// manifest stitched from two commits.
test("a branch that moves mid-run is refused as stale instead of blending two commits", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "one\n");
  const pinned = await commitAll(repo, "first");
  const source = createGitRefProvider({ repoDir: repo });
  let moved = false;
  const moving: RefProvider = {
    resolveRef: (ref) => source.resolveRef(ref),
    listTree: (commit, page) => source.listTree(commit, page),
    async readBlob(commit, path) {
      const content = await source.readBlob(commit, path);
      if (!moved) {
        moved = true;
        await write(repo, "a.txt", "two\n");
        await commitAll(repo, "second");
      }
      return content;
    },
  };

  const run = await readCommittedRef(moving, { ref: "main" });
  assert.equal(run.outcome, REF_RUN_OUTCOME.STALE_REF);
  assert.equal(run.complete, false);
  assert.equal(run.commit, pinned);
  assert.deepEqual(run.manifest, []);
  const tip = (await git(repo, ["rev-parse", "main"])).toString("utf8").trim();
  assert.notEqual(tip, pinned);
});

// Behaviour: a symlink is served as a blob, so the git mode is the only signal that it is
// not a regular file. The adapter keeps the mode and the connector refuses the tree.
test("a symlink keeps its git mode so the run refuses the tree as unsafe", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "one\n");
  await symlink("a.txt", join(repo, "link.txt"));
  const commit = await commitAll(repo, "link");
  const provider = createGitRefProvider({ repoDir: repo });

  const page = await provider.listTree(commit, 1);
  assert.deepEqual(page.entries.find((entry) => entry.path === "link.txt"), { path: "link.txt", type: "blob", mode: "120000" });

  const run = await readCommittedRef(provider, { ref: "main" });
  assert.equal(run.outcome, REF_RUN_OUTCOME.UNSAFE_TREE);
  assert.equal(run.complete, false);
  assert.deepEqual(run.violations, [{ path: "link.txt", reason: "SYMLINK" }]);
  assert.deepEqual(run.manifest, []);
});

// Behaviour: a tree can name bytes no JSON string can carry. Dropping that entry would
// present the remaining files as complete coverage, so the enumeration is refused whole.
test("a path that is not UTF-8 makes the enumeration incomplete, never a partial tree", async () => {
  const repo = await newRepo();
  await write(repo, "ok.txt", "ok\n");
  const base = await commitAll(repo, "base");
  const blob = (await git(repo, ["rev-parse", `${base}:ok.txt`])).toString("utf8").trim();
  // mktree -z is the only way to write such a name: no filesystem here accepts it.
  const tree = (
    await gitWithInput(
      repo,
      ["mktree", "-z"],
      Buffer.concat([
        Buffer.from(`100644 blob ${blob}\tok.txt\0`),
        Buffer.from(`100644 blob ${blob}\tbad`),
        Buffer.from([0xff]),
        Buffer.from("name.txt\0"),
      ]),
    )
  )
    .toString("utf8")
    .trim();
  const commit = (await gitWithInput(repo, ["commit-tree", tree], Buffer.from("invalid path\n"))).toString("utf8").trim();
  await git(repo, ["update-ref", "refs/heads/weird", commit]);
  const provider = createGitRefProvider({ repoDir: repo });

  await assert.rejects(() => provider.listTree(commit, 1), /not valid UTF-8/);

  const run = await readCommittedRef(provider, { ref: "weird" });
  assert.equal(run.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(run.complete, false);
  assert.deepEqual(run.manifest, []);
  assert.match(run.failure ?? "", /not valid UTF-8/);
});

// Behaviour: the tree still lists a path whose blob is gone from the object store. That
// read fails, and the run reports an incomplete tree instead of a complete one missing text.
test("a blob missing from the object store makes the run incomplete, not complete", async () => {
  const repo = await newRepo();
  await write(repo, "kept.txt", "kept\n");
  await write(repo, "src/dropped.ts", "dropped\n");
  const commit = await commitAll(repo, "objects");
  const oid = (await git(repo, ["rev-parse", `${commit}:src/dropped.ts`])).toString("utf8").trim();
  await rm(join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  const provider = createGitRefProvider({ repoDir: repo });

  const run = await readCommittedRef(provider, { ref: "main" });
  assert.equal(run.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(run.complete, false);
  assert.deepEqual(run.manifest, []);
  assert.match(run.failure ?? "", /src\/dropped\.ts/);
});

// Behaviour: a ref the repository cannot resolve is the caller's adapter failure, so it is
// thrown rather than answered as an empty commit that would look like a tree with no files.
test("a ref that does not resolve fails loudly instead of answering an empty commit", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "one\n");
  await commitAll(repo, "first");
  const provider = createGitRefProvider({ repoDir: repo });

  const failure = await provider.resolveRef("no-such-branch").then(
    () => assert.fail("a missing ref must not resolve"),
    (error: Error) => error,
  );
  assert.match(failure.message, /could not be resolved/);
  assert.match(failure.message, /no-such-branch/);
  await assert.rejects(() => readCommittedRef(provider, { ref: "no-such-branch" }), /could not be resolved/);
});

// Behaviour: only a full commit sha addresses a fetch, and the tree is one complete page.
// A branch name would let the tip move between the listing and the blob reads, and a
// second page would let a caller mistake a finished listing for more of it.
test("a fetch is addressed only by a full commit sha and only by the page the tree has", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "one\n");
  const commit = await commitAll(repo, "first");
  const provider = createGitRefProvider({ repoDir: repo });

  await assert.rejects(() => provider.listTree("main", 1), /full commit sha/);
  await assert.rejects(() => provider.readBlob("HEAD", "a.txt"), /full commit sha/);
  await assert.rejects(() => provider.listTree(commit.slice(0, 12), 1), /full commit sha/);
  await assert.rejects(() => provider.listTree(commit, 2), /page 2/);
});

// Behaviour: a git call that stops answering is killed at its deadline instead of holding
// the publish transaction for its whole budget, and a timeout is its own failure, not the
// answer "that path is not in the tree": absence and a deadline stay distinguishable, which
// matters because a deletion is inferred from what the tree does not contain.
test("a git call that hangs fails by the timeout, and a timeout is not a missing file", async () => {
  const repo = await newRepo();
  await write(repo, "a.txt", "one\n");
  const commit = await commitAll(repo, "first");
  const provider = createGitRefProvider({ repoDir: repo, timeoutMs: 300 });

  // A path the commit does not hold: git answers "does not exist", which is an absence, so
  // the deadline must not have swallowed that answer into a timeout.
  const absent = await provider.readBlob(commit, "absent.txt").then(
    () => assert.fail("a missing blob must not be read"),
    (error: Error & { code?: string }) => error,
  );
  assert.match(absent.message, /does not exist in/);
  assert.doesNotMatch(absent.message, /timed out/);
  assert.notEqual(absent.name, "GitTimeoutError");
  assert.notEqual(absent.code, "GIT_TIMEOUT");

  // Every git invocation the adapter makes is bounded: the ref, the tree and the blob.
  const calls: Array<() => Promise<unknown>> = [
    () => provider.resolveRef("main"),
    () => provider.listTree(commit, 1),
    () => provider.readBlob(commit, "a.txt"),
  ];
  for (const call of calls) {
    const started = Date.now();
    const failure = await underStallingGit(call).then(
      () => assert.fail("a stalled git must not answer"),
      (error: Error & { code?: string }) => error,
    );
    assert.equal(failure.name, "GitTimeoutError", `git did not answer: ${failure.message}`);
    assert.equal(failure.code, "GIT_TIMEOUT", `git did not answer: ${failure.message}`);
    assert.match(failure.message, /timed out after 300ms/);
    assert.ok(Date.now() - started < 1200, "the deadline cut the call short, not the stub's own exit");
  }

  // A timed-out blob read leaves the run incomplete and deletes nothing: reading the deadline
  // as an absent file would publish a manifest that drops a file the commit still holds.
  const stalling: RefProvider = {
    resolveRef: (ref) => provider.resolveRef(ref),
    listTree: (atCommit, page) => provider.listTree(atCommit, page),
    readBlob: (atCommit, path) => underStallingGit(() => provider.readBlob(atCommit, path)),
  };
  const run = await readCommittedRef(stalling, { ref: "main", previousPaths: ["a.txt"] });
  assert.equal(run.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(run.complete, false);
  assert.match(run.failure ?? "", /timed out after 300ms/);
  assert.deepEqual(run.manifest, []);
  assert.deepEqual(run.deletions, []);
});

// Behaviour: a deadline that is not a positive count bounds nothing, so the provider refuses
// to be built instead of timing out every read it is ever asked for.
test("a deadline that is not a positive count is refused when the provider is built", async () => {
  const repo = await newRepo();

  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createGitRefProvider({ repoDir: repo, timeoutMs }),
      /timeoutMs/,
      `timeoutMs ${timeoutMs} is refused`,
    );
  }
});

after(async () => {
  for (const repo of fixtureRepos) await rm(repo, { recursive: true, force: true });
});
