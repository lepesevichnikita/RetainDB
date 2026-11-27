import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  REF_RUN_OUTCOME,
  TREE_PAGES_MAX,
  readCommittedRef,
  type RefProvider,
  type RefTreeEntry,
  type RefTreePage,
  type RefViolationReason,
} from "../src/connectors/repo-ref.js";
import { PUBLISHED_PAGES_MAX } from "../src/engine/repo-index/connector-run.js";

// Lowercase sha a provider would really answer with, so address validation is
// exercised by realistic values instead of a placeholder like "commit-1".
const SHA_PINNED = "9f1e2d4c7b6a58f30d2e1c0b9a8f7e6d5c4b3a29";
const SHA_MOVED = "0c11ee7b6a58f30d2e1c0b9a8f7e6d5c4b3a2900";

interface FakeRepo {
  /** Tree pages in the order the provider serves them. */
  pages: RefTreeEntry[][];
  /** Blob content at the pinned commit, addressed by relative path. */
  blobs: Record<string, string>;
  /** What the ref points at when the run starts. */
  head: string;
  /** What the ref points at once it has moved. */
  movedHead?: string;
  /** Number of blob reads after which the ref moves. */
  moveAfterBlobReads?: number;
  /** Number of tree pages after which the ref moves. */
  moveAfterTreePages?: number;
  /** Page number that the provider fails to serve. */
  failTreePage?: number;
  /** Resolve call (1-based) that fails instead of answering. */
  failResolveFrom?: number;
  /** Pagination pointer a page announces instead of the default next page. */
  nextPages?: Record<number, number | null>;
  /**
   * Answers served in order whatever page number is asked for, so a test can prove
   * the connector stopped before asking the provider for another page.
   */
  served?: RefTreePage[];
}

// Fake provider: records every address it is asked for, so a test can prove which
// commit each fetch used, and can move the branch under a running fetch.
function fakeProvider(repo: FakeRepo) {
  const calls = {
    resolved: [] as string[],
    tree: [] as Array<{ commit: string; page: number }>,
    blobs: [] as Array<{ commit: string; path: string }>,
  };
  const moveAfterBlobs = repo.moveAfterBlobReads ?? Number.POSITIVE_INFINITY;
  const moveAfterTrees = repo.moveAfterTreePages ?? Number.POSITIVE_INFINITY;
  const hasMoved = () => calls.blobs.length >= moveAfterBlobs || calls.tree.length >= moveAfterTrees;
  const currentHead = () => (repo.movedHead && hasMoved() ? repo.movedHead : repo.head);
  const nextPages = repo.nextPages ?? {};
  let lastPage = 0;
  const provider: RefProvider = {
    async resolveRef(ref: string) {
      calls.resolved.push(ref);
      if (repo.failResolveFrom !== undefined && calls.resolved.length >= repo.failResolveFrom) {
        throw new Error(`ref ${ref} unavailable`);
      }
      return currentHead();
    },
    async listTree(commit: string, page: number) {
      calls.tree.push({ commit, page });
      // Scripted answers come first: they model a provider that would happily serve
      // a pointer the connector must refuse, so only the guard can stop the run.
      if (repo.served) {
        const answer = repo.served[calls.tree.length - 1];
        if (!answer) throw new Error(`tree page ${page} unavailable`);
        return answer;
      }
      // A real provider serves pages forward only, so a repeated or backwards
      // request is an error rather than an endless replay of the same page.
      if (page <= lastPage) throw new Error(`tree page ${page} requested after page ${lastPage}`);
      lastPage = page;
      if (repo.failTreePage === page) throw new Error(`tree page ${page} unavailable`);
      const entries = repo.pages[page - 1] ?? [];
      const announced = nextPages[page];
      const defaultNext = page < repo.pages.length ? page + 1 : null;
      return { entries, nextPage: announced === undefined ? defaultNext : announced };
    },
    async readBlob(commit: string, path: string) {
      calls.blobs.push({ commit, path });
      const content = repo.blobs[path];
      if (content === undefined) throw new Error(`blob ${path} unavailable`);
      return content;
    },
  };
  return { provider, calls };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Behaviour: the first resolution pins the ref to an immutable commit, and every
// tree and blob fetch afterwards is addressed by that commit sha, never by the
// branch name that can move.
test("a ref is pinned to one commit and every later fetch uses that sha", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [
      [{ path: "src/a.ts", type: "blob", mode: "100644" }, { path: "src/b.ts", type: "blob", mode: "100644" }],
      [{ path: "README.md", type: "blob", mode: "100644" }],
    ],
    blobs: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "README.md": "# demo\n" },
  });

  const result = await readCommittedRef(provider, { ref: "refs/heads/feat-upload" });

  assert.equal(result.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.equal(result.commit, SHA_PINNED);
  // The pin comes from the first resolution; later reads of the ref exist only to
  // notice movement, and the result stays the commit those reads are compared to.
  assert.equal(calls.resolved[0], "refs/heads/feat-upload");
  assert.ok(calls.resolved.every((ref) => ref === "refs/heads/feat-upload"));
  assert.equal(calls.tree.length, 2);
  assert.ok(calls.tree.every((call) => call.commit === SHA_PINNED));
  assert.equal(calls.blobs.length, 3);
  assert.ok(calls.blobs.every((call) => call.commit === SHA_PINNED));
  assert.ok([...calls.tree, ...calls.blobs].every((call) => call.commit !== "refs/heads/feat-upload"));
});

// Behaviour: a ref that moves while files are being fetched is refused as stale
// and publishes nothing, so one manifest can never mix two revisions.
test("a ref that moves mid-run is refused as stale and publishes nothing", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    movedHead: SHA_MOVED,
    moveAfterBlobReads: 1,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }, { path: "src/b.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main", previousPaths: ["src/a.ts", "src/gone.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.STALE_REF);
  assert.equal(result.complete, false);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.ok(calls.blobs.length > 0, "the fetch had already started when the ref moved");
  assert.ok([...calls.tree, ...calls.blobs].every((call) => call.commit === SHA_PINNED));
});

// Behaviour: once the provider reports that the ref moved, the run stops instead
// of reading the files of a commit it can no longer publish.
test("a ref that moved during tree enumeration stops before any file is read", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    movedHead: SHA_MOVED,
    moveAfterTreePages: 1,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }, { path: "src/b.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main", previousPaths: ["src/a.ts", "src/b.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.STALE_REF);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.deepEqual(calls.blobs, []);
});

// Behaviour: a blob the provider cannot serve leaves a hole in the manifest, so the
// run is incomplete rather than a publishable tree that would look like a deletion.
test("a blob that cannot be read makes the run incomplete and publishes nothing", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }, { path: "src/b.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": "export const a = 1;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main", previousPaths: ["src/a.ts", "src/b.ts", "src/gone.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.match(result.failure ?? "", /blob src\/b\.ts unavailable/);
  assert.deepEqual(calls.blobs.map((call) => call.path), ["src/a.ts", "src/b.ts"]);
});

// Behaviour: a tree the provider cannot finish serving is reported as incomplete,
// never as full coverage and never as a deletion signal for the files it missed.
test("a tree that fails mid-pagination is incomplete and deletes nothing", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    failTreePage: 2,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }], [{ path: "src/b.ts", type: "blob", mode: "100644" }, { path: "src/c.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "src/c.ts": "export const c = 3;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main", previousPaths: ["src/a.ts", "src/b.ts", "src/c.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.match(result.failure ?? "", /page 2 unavailable/);
  assert.deepEqual(calls.blobs, []);
});

// Behaviour: entries whose path leaves the tree root are refused as a whole run,
// because a manifest cannot describe them. A directory path is validated before
// its type lets it through, so a tree entry cannot skip the check.
test("path escapes and malformed paths are refused", async () => {
  const hostile: Array<{ entry: RefTreeEntry; reason: RefViolationReason }> = [
    { entry: { path: "", type: "blob", mode: "100644" }, reason: "ABSOLUTE_PATH" },
    { entry: { path: "/etc/passwd", type: "blob", mode: "100644" }, reason: "ABSOLUTE_PATH" },
    { entry: { path: "..\\..\\etc\\passwd", type: "blob", mode: "100644" }, reason: "ABSOLUTE_PATH" },
    { entry: { path: "src\\link.ts", type: "blob", mode: "100644" }, reason: "ABSOLUTE_PATH" },
    { entry: { path: "../outside.txt", type: "blob", mode: "100644" }, reason: "PARENT_SEGMENT" },
    { entry: { path: "src//a.ts", type: "blob", mode: "100644" }, reason: "PARENT_SEGMENT" },
    { entry: { path: "src/./a.ts", type: "blob", mode: "100644" }, reason: "PARENT_SEGMENT" },
    { entry: { path: "../outside", type: "tree" }, reason: "PARENT_SEGMENT" },
    { entry: { path: "/abs", type: "tree" }, reason: "ABSOLUTE_PATH" },
    // A drive-letter prefix names a location outside the root on a Windows host.
    { entry: { path: "C:/windows/x", type: "blob", mode: "100644" }, reason: "ABSOLUTE_PATH" },
    // A NUL or any other control character cannot be part of a served file name.
    { entry: { path: "src/evil\u0000.ts", type: "blob", mode: "100644" }, reason: "CONTROL_CHARACTER" },
    { entry: { path: "src/line\nbreak.ts", type: "blob", mode: "100644" }, reason: "CONTROL_CHARACTER" },
  ];

  for (const { entry, reason } of hostile) {
    const { provider, calls } = fakeProvider({
      head: SHA_PINNED,
      pages: [[{ path: "src/ok.ts", type: "blob", mode: "100644" }, entry]],
      // Every hostile path is served, so a run that lets it through publishes it.
      blobs: { "src/ok.ts": "export const ok = true;\n", [entry.path]: "export const x = true;\n" },
    });

    const result = await readCommittedRef(provider, { ref: "main" });

    assert.equal(result.outcome, REF_RUN_OUTCOME.UNSAFE_TREE, `${JSON.stringify(entry)} refuses the run`);
    assert.equal(result.complete, false);
    assert.deepEqual(result.manifest, []);
    assert.deepEqual(result.violations, [{ path: entry.path, reason }], `${JSON.stringify(entry)} reports ${reason}`);
    assert.deepEqual(calls.blobs, [], `${JSON.stringify(entry)} reads no file`);
  }
});

// Behaviour: a symlink leaves the root when read and a submodule is not part of
// this tree, so both are refused. GitHub and GitLab publish each as a plain blob
// with a git mode, so the mode has to refuse them even when the type looks safe.
test("a symlink or submodule published as a blob is refused by its mode", async () => {
  const hostile: Array<{ entry: RefTreeEntry; reason: RefViolationReason }> = [
    { entry: { path: "src/link.ts", type: "symlink" }, reason: "SYMLINK" },
    { entry: { path: "src/link.ts", type: "blob", mode: "120000" }, reason: "SYMLINK" },
    { entry: { path: "vendor/lib", type: "commit" }, reason: "SUBMODULE" },
    { entry: { path: "vendor/lib", type: "blob", mode: "160000" }, reason: "SUBMODULE" },
  ];

  for (const { entry, reason } of hostile) {
    const { provider, calls } = fakeProvider({
      head: SHA_PINNED,
      pages: [[{ path: "src/ok.ts", type: "blob", mode: "100644" }, entry]],
      blobs: { "src/ok.ts": "export const ok = true;\n", [entry.path]: "target.ts\n" },
    });

    const result = await readCommittedRef(provider, { ref: "main" });

    assert.equal(result.outcome, REF_RUN_OUTCOME.UNSAFE_TREE, `${JSON.stringify(entry)} refuses the run`);
    assert.deepEqual(result.violations, [{ path: entry.path, reason }], `${JSON.stringify(entry)} reports ${reason}`);
    assert.deepEqual(calls.blobs, [], `${JSON.stringify(entry)} reads no file`);
  }
});

// Behaviour: the provider's type alone cannot tell a regular file from a link, so
// a blob whose mode is missing or is not the git mode string cannot be read: the
// link target would be published as the file's content. A zero padded mode is not
// the value the provider meant either, so it is refused rather than compared.
test("a blob whose mode does not name a regular file is refused", async () => {
  const hostile: RefTreeEntry[] = [
    { path: "src/link.ts", type: "blob" },
    { path: "src/link.ts", type: "blob", mode: 120000 } as unknown as RefTreeEntry,
    { path: "src/link.ts", type: "blob", mode: "0120000" },
  ];

  for (const entry of hostile) {
    const { provider, calls } = fakeProvider({
      head: SHA_PINNED,
      pages: [[entry]],
      blobs: { [entry.path]: "target.ts\n" },
    });

    const result = await readCommittedRef(provider, { ref: "main" });

    assert.equal(result.outcome, REF_RUN_OUTCOME.UNSAFE_TREE, `${JSON.stringify(entry)} refuses the run`);
    assert.equal(result.complete, false);
    assert.deepEqual(result.violations, [{ path: entry.path, reason: "UNKNOWN_MODE" }], `${JSON.stringify(entry)} reports UNKNOWN_MODE`);
    assert.deepEqual(result.manifest, [], `${JSON.stringify(entry)} publishes no content`);
    assert.deepEqual(calls.blobs, [], `${JSON.stringify(entry)} reads no file`);
  }
});

// Behaviour: a gitlink served as a directory is not part of this tree, and a
// directory is not read, so without the mode check the entry would vanish from the
// manifest without a word. The run is refused instead.
test("a gitlink served as a directory is refused instead of dropped", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [[{ path: "src/ok.ts", type: "blob", mode: "100644" }, { path: "vendor/lib", type: "tree", mode: "160000" }]],
    blobs: { "src/ok.ts": "export const ok = true;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main" });

  assert.equal(result.outcome, REF_RUN_OUTCOME.UNSAFE_TREE);
  assert.equal(result.complete, false);
  assert.deepEqual(result.violations, [{ path: "vendor/lib", reason: "SUBMODULE" }]);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(calls.blobs, []);
});

// Behaviour: one run reports every unsafe entry it found, so a caller repairing
// the tree sees all of them at once instead of one refusal per attempt.
test("every unsafe entry of one run is reported, not only the first", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [
      [{ path: "/etc/passwd", type: "blob", mode: "100644" }],
      [{ path: "src/link.ts", type: "blob", mode: "120000" }, { path: "../outside.txt", type: "blob", mode: "100644" }],
    ],
    blobs: {},
  });

  const result = await readCommittedRef(provider, { ref: "main" });

  assert.equal(result.outcome, REF_RUN_OUTCOME.UNSAFE_TREE);
  assert.equal(result.violations.length, 3);
  assert.deepEqual(result.violations, [
    { path: "/etc/passwd", reason: "ABSOLUTE_PATH" },
    { path: "src/link.ts", reason: "SYMLINK" },
    { path: "../outside.txt", reason: "PARENT_SEGMENT" },
  ]);
  assert.deepEqual(calls.blobs, []);
});

// Behaviour: a parent segment is refused wherever it sits, not just when it is the
// first segment, because "../../etc/passwd" and "src/deep/../../../etc/passwd"
// leave the root in the same way.
test("a parent segment is refused wherever it sits in the path", async () => {
  for (const path of ["src/deep/../../../etc/passwd", "src/generated/../..", "a/b/../c"]) {
    const { provider, calls } = fakeProvider({
      head: SHA_PINNED,
      pages: [[{ path, type: "blob", mode: "100644" }]],
      blobs: {},
    });

    const result = await readCommittedRef(provider, { ref: "main" });

    assert.equal(result.outcome, REF_RUN_OUTCOME.UNSAFE_TREE, `${path} refuses the run`);
    assert.deepEqual(result.violations, [{ path, reason: "PARENT_SEGMENT" }]);
    assert.deepEqual(calls.blobs, []);
  }
});

// Behaviour: a page pointer that does not move forward is a broken enumeration, so
// the run stops as incomplete instead of replaying a page or looping forever.
test("a pagination pointer that does not move forward stops the run", async () => {
  for (const announced of [0, 1]) {
    const { provider, calls } = fakeProvider({
      head: SHA_PINNED,
      pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }], [{ path: "src/b.ts", type: "blob", mode: "100644" }]],
      nextPages: { 1: announced },
      blobs: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" },
    });

    const result = await readCommittedRef(provider, { ref: "main" });

    assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE, `next page ${announced} refuses the run`);
    assert.match(result.failure ?? "", new RegExp(`tree page 1 announced next page ${announced}`));
    assert.deepEqual(calls.tree.map((call) => call.page), [1], `next page ${announced} is never fetched`);
    assert.deepEqual(calls.blobs, []);
    assert.deepEqual(result.manifest, []);
  }
});

// Behaviour: a pointer that is not ahead of the page just read is refused, even
// when the provider would answer the pointer with a finished tree. Reading it as
// the end would publish a manifest missing every page after it, and a manifest
// fences deletions, so the run stops as incomplete instead.
test("a pointer that goes back is refused instead of read as a finished tree", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    // Scripted answers ignore the page number, so only the guard stops the second
    // request; without it the run would publish the two blobs it was served.
    pages: [],
    served: [
      { entries: [{ path: "src/a.ts", type: "blob", mode: "100644" }], nextPage: 0 },
      { entries: [{ path: "src/b.ts", type: "blob", mode: "100644" }], nextPage: null },
    ],
    blobs: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main" });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(calls.tree.map((call) => call.page), [1], "page 0 is never requested");
  assert.deepEqual(calls.blobs, []);
});

// Behaviour: a page number is a whole number, so a fractional pointer is refused
// before the provider is asked for a page that cannot exist.
test("a fractional next page is refused before the provider is asked for it", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
    nextPages: { 1: 1.5 },
    blobs: { "src/a.ts": "export const a = 1;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main" });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.match(result.failure ?? "", /tree page 1 announced next page 1\.5/);
  assert.deepEqual(calls.tree.map((call) => call.page), [1], "page 1.5 is never requested");
  assert.deepEqual(calls.blobs, []);
  assert.deepEqual(result.manifest, []);
});

// Behaviour: only a full commit sha names an immutable revision, so any other
// answer is refused as a value before a single tree page is read. Length is exact:
// 40 for sha1 and 64 for sha256, so a longer hex run is not a commit either.
test("a resolution that is not a commit sha is refused before the tree is read", async () => {
  const notCommits = [
    "refs/heads/main",
    "commit-9f1e2d",
    "9f1e2d4c",
    SHA_PINNED.slice(0, 39),
    `${SHA_PINNED}a`,
    `${SHA_PINNED}${SHA_PINNED}`.slice(0, 50),
    `${SHA_PINNED}${SHA_PINNED}`.slice(0, 63),
    `${SHA_PINNED}${SHA_PINNED}`.slice(0, 65),
    SHA_PINNED.toUpperCase(),
  ];

  for (const head of notCommits) {
    const { provider, calls } = fakeProvider({
      head,
      pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
      blobs: { "src/a.ts": "export const a = 1;\n" },
    });

    const result = await readCommittedRef(provider, { ref: "main" });

    assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE, `${head} refuses the run`);
    assert.equal(result.complete, false);
    assert.equal(result.commit, "", `${head} pins nothing`);
    assert.match(result.failure ?? "", /is not a commit sha/);
    assert.deepEqual(calls.tree, []);
    assert.deepEqual(calls.blobs, []);
    assert.deepEqual(result.manifest, []);
  }
});

// Behaviour: a sha256 repository answers with a 64 character object id, so the
// address check has to accept it instead of only sha1.
test("a sha256 object id is accepted as a commit", async () => {
  const sha256Commit = `${SHA_PINNED}${SHA_PINNED}`.slice(0, 64);
  const { provider, calls } = fakeProvider({
    head: sha256Commit,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": "export const a = 1;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main" });

  assert.equal(result.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.equal(result.commit, sha256Commit);
  assert.ok(calls.blobs.every((call) => call.commit === sha256Commit));
});

// Behaviour: a path that appears twice would make the publication fence refuse the
// manifest, so the connector refuses it before reading any content.
test("a path published twice across pages is refused", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [
      [{ path: "src/a.ts", type: "blob", mode: "100644" }],
      [{ path: "src/a.ts", type: "blob", mode: "100644" }, { path: "src/b.ts", type: "blob", mode: "100644" }],
    ],
    blobs: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main" });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.match(result.failure ?? "", /path src\/a\.ts appears more than once/);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.deepEqual(calls.blobs, []);
});

// Behaviour: a caller can bound how much content one run materialises; a blob over
// that bound stops the run instead of being digested into a manifest that claims
// coverage it never checked.
test("a blob over the size limit is refused as incomplete", async () => {
  const content = "0123456789";
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": content },
  });

  const result = await readCommittedRef(provider, { ref: "main", maxBlobBytes: 9 });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.match(result.failure ?? "", /blob src\/a\.ts is 10 bytes, over the 9 byte limit/);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.deepEqual(calls.blobs.map((call) => call.path), ["src/a.ts"]);
});

// Behaviour: the limit is a maximum, not an exclusive bound, so a blob exactly at
// the limit is still published.
test("a blob exactly at the size limit is published", async () => {
  const content = "0123456789";
  const { provider } = fakeProvider({
    head: SHA_PINNED,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": content },
  });

  const result = await readCommittedRef(provider, { ref: "main", maxBlobBytes: 10 });

  assert.equal(result.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.deepEqual(result.manifest, [{ path: "src/a.ts", digest: sha256(content) }]);
});

// Behaviour: the bound is compared against the bytes that arrived, so a blob of
// multi-byte characters is refused when its encoded size is over the limit even
// though its character count fits.
test("a multi-byte blob over the byte limit is refused even when its characters fit", async () => {
  const content = "€€€"; // 3 characters, 9 utf8 bytes
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": content },
  });

  const result = await readCommittedRef(provider, { ref: "main", maxBlobBytes: 8 });

  assert.equal(content.length, 3);
  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.match(result.failure ?? "", /blob src\/a\.ts is 9 bytes, over the 8 byte limit/);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.deepEqual(calls.blobs.map((call) => call.path), ["src/a.ts"]);
});

// Behaviour: a bound that is not a byte count bounds nothing, because every
// comparison against NaN is false, so the run is refused as incomplete instead of
// reading every blob unbounded.
test("a size bound that is not a finite byte count refuses the run", async () => {
  for (const maxBlobBytes of [Number.NaN, -1]) {
    const { provider, calls } = fakeProvider({
      head: SHA_PINNED,
      pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
      blobs: { "src/a.ts": "0123456789" },
    });

    const result = await readCommittedRef(provider, { ref: "main", maxBlobBytes });

    assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE, `maxBlobBytes ${maxBlobBytes} refuses the run`);
    assert.equal(result.complete, false);
    assert.match(result.failure ?? "", /maxBlobBytes .* is not a finite non-negative byte count/);
    assert.deepEqual(result.manifest, []);
    assert.deepEqual(result.deletions, []);
    // A bound that cannot be honoured refuses before the ref is even pinned.
    assert.deepEqual(calls.resolved, [], `maxBlobBytes ${maxBlobBytes} reads no ref`);
    assert.deepEqual(calls.tree, [], `maxBlobBytes ${maxBlobBytes} reads no tree`);
    assert.deepEqual(calls.blobs, [], `maxBlobBytes ${maxBlobBytes} reads no blob`);
  }
});

// Behaviour: a transport error while re-reading the ref is a refusal value, not a
// rejected promise, so the run ends incomplete instead of crashing the caller.
test("a failing staleness re-check before the blobs is incomplete, not a crash", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    failResolveFrom: 2,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": "export const a = 1;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main", previousPaths: ["src/a.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.match(result.failure ?? "", /ref main unavailable/);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.deepEqual(calls.blobs, []);
});

// Behaviour: the same holds for the re-check after the blobs, so a manifest that
// was read but never confirmed as head is never published.
test("a failing staleness re-check after the blobs is incomplete, not a crash", async () => {
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    failResolveFrom: 3,
    pages: [[{ path: "src/a.ts", type: "blob", mode: "100644" }]],
    blobs: { "src/a.ts": "export const a = 1;\n" },
  });

  const result = await readCommittedRef(provider, { ref: "main", previousPaths: ["src/a.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.match(result.failure ?? "", /ref main unavailable/);
  assert.deepEqual(result.manifest, []);
  assert.deepEqual(result.deletions, []);
  assert.deepEqual(calls.blobs.map((call) => call.path), ["src/a.ts"]);
});

// Behaviour: a clean run returns the complete manifest of relative paths with a
// content digest each, plus the resolved sha, and only then may it signal deletions.
test("a clean run returns a complete manifest at the resolved commit", async () => {
  const contents = {
    "src/index.ts": "export const main = () => {};\n",
    "src/util.ts": "export const twice = (x: number) => x * 2;\n",
    "README.md": "# project\n",
  };
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [
      [{ path: "src/index.ts", type: "blob", mode: "100644" }, { path: "src/util.ts", type: "blob", mode: "100644" }, { path: "src", type: "tree" }],
      [{ path: "README.md", type: "blob", mode: "100644" }],
    ],
    blobs: contents,
  });

  const result = await readCommittedRef(provider, { ref: "release/1.4", previousPaths: ["src/old.ts", "src/index.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.equal(result.complete, true);
  assert.equal(result.commit, SHA_PINNED);
  assert.equal(result.failure, null);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.manifest, [
    { path: "README.md", digest: sha256(contents["README.md"]) },
    { path: "src/index.ts", digest: sha256(contents["src/index.ts"]) },
    { path: "src/util.ts", digest: sha256(contents["src/util.ts"]) },
  ]);
  assert.deepEqual(result.deletions, ["src/old.ts"]);
  assert.ok(calls.blobs.every((call) => call.commit === SHA_PINNED));
});

// Behaviour: the ordinary path across several pages keeps working: a tree larger than
// one page is enumerated whole, every page is read in order, an empty page is not taken
// for the end, and the complete manifest still declares the one path that went away.
test("a tree larger than one page is enumerated whole", async () => {
  const contents: Record<string, string> = {
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    "docs/readme.md": "# readme\n",
    "docs/guide.md": "# guide\n",
    "config/app.json": '{"port":8080}\n',
    "config/ci.json": '{"ci":true}\n',
  };
  const { provider, calls } = fakeProvider({
    head: SHA_PINNED,
    pages: [
      [{ path: "src/a.ts", type: "blob", mode: "100644" }, { path: "src/b.ts", type: "blob", mode: "100644" }],
      // A page with nothing on it still announces the next one, so only the pointer ends
      // the enumeration; reading this as the end would publish two files as the whole tree.
      [],
      [{ path: "docs/readme.md", type: "blob", mode: "100644" }, { path: "docs/guide.md", type: "blob", mode: "100644" }],
      [{ path: "config/app.json", type: "blob", mode: "100644" }, { path: "config/ci.json", type: "blob", mode: "100644" }],
    ],
    blobs: contents,
  });

  const result = await readCommittedRef(provider, { ref: "main", previousPaths: ["src/a.ts", "src/gone.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.equal(result.complete, true);
  assert.deepEqual(calls.tree.map((call) => call.page), [1, 2, 3, 4], "every page is read in order");
  assert.deepEqual(calls.blobs.map((call) => call.path).sort(), Object.keys(contents).sort());
  assert.deepEqual(result.manifest, [
    { path: "config/app.json", digest: sha256(contents["config/app.json"]) },
    { path: "config/ci.json", digest: sha256(contents["config/ci.json"]) },
    { path: "docs/guide.md", digest: sha256(contents["docs/guide.md"]) },
    { path: "docs/readme.md", digest: sha256(contents["docs/readme.md"]) },
    { path: "src/a.ts", digest: sha256(contents["src/a.ts"]) },
    { path: "src/b.ts", digest: sha256(contents["src/b.ts"]) },
  ]);
  assert.deepEqual(result.deletions, ["src/gone.ts"]);
});

// Behaviour: a provider that keeps announcing another page is refused at the page
// ceiling instead of growing the manifest until memory runs out. The refusal is its own
// failure, never a finished tree: the pages read so far are a prefix, so publishing them
// would report every file the remaining pages hold as deleted.
test("a provider that keeps announcing another page is refused at the ceiling", async () => {
  // The number is part of the contract, not of this module alone: engine/repo-index/connector-run.ts
  // bounds its own paging loop at PUBLISHED_PAGES_MAX, and the review's requirement is that the two
  // agree. Comparing the two constants (not a copied 100) fails if either loop drifts to its own
  // ceiling, which is the state repo-ref.ts's comment rules out.
  assert.equal(TREE_PAGES_MAX, PUBLISHED_PAGES_MAX, "the tree ceiling matches the run's published-tree ceiling");

  const asked: number[] = [];
  const read: string[] = [];
  const endless: RefProvider = {
    async resolveRef() {
      return SHA_PINNED;
    },
    async listTree(_commit: string, page: number) {
      asked.push(page);
      // The tripwire is what keeps a connector without a ceiling terminating: it answers
      // one page past the bound, so an unbounded loop fails this test instead of hanging
      // the suite, and a bounded one never asks.
      if (page > TREE_PAGES_MAX) throw new Error(`page ${page} is past the ${TREE_PAGES_MAX} page ceiling`);
      return { entries: [{ path: `src/f${page}.ts`, type: "blob", mode: "100644" }], nextPage: page + 1 };
    },
    async readBlob(_commit: string, path: string) {
      // Content is served, so a connector that stopped silently would publish the pages it
      // read as the whole tree instead of failing here for an unrelated reason.
      read.push(path);
      return `${path}\n`;
    },
  };

  const result = await readCommittedRef(endless, { ref: "main", previousPaths: ["src/f1.ts"] });

  assert.equal(result.outcome, REF_RUN_OUTCOME.INCOMPLETE_TREE);
  assert.equal(result.complete, false);
  assert.deepEqual(result.manifest, [], "a tree cut off at the ceiling is never published");
  assert.deepEqual(result.deletions, [], "a tree cut off at the ceiling deletes nothing");
  assert.match(result.failure ?? "", new RegExp(`did not finish within ${TREE_PAGES_MAX} pages`));
  assert.deepEqual(read, [], "no blob of a tree that was never finished is read");
  assert.deepEqual(
    asked,
    Array.from({ length: TREE_PAGES_MAX }, (_, index) => index + 1),
    "the connector stopped at the ceiling instead of reading past it",
  );
});

// Behaviour: the ceiling bounds a broken provider, not a big tree. A tree that fills every
// page the ceiling allows is still enumerated whole and published complete, so the guard
// cannot cut off a legitimate repository one page early.
test("a tree that fills every page the ceiling allows still completes", async () => {
  const pages = Array.from({ length: TREE_PAGES_MAX }, (_, index) => [
    { path: `src/f${String(index + 1).padStart(3, "0")}.ts`, type: "blob" as const, mode: "100644" },
  ]);
  const blobs = Object.fromEntries(pages.map(([entry]) => [entry.path, `${entry.path}\n`]));
  const { provider, calls } = fakeProvider({ head: SHA_PINNED, pages, blobs });

  const result = await readCommittedRef(provider, { ref: "main" });

  assert.equal(result.outcome, REF_RUN_OUTCOME.COMPLETE);
  assert.equal(calls.tree.length, TREE_PAGES_MAX);
  assert.deepEqual(calls.tree.map((call) => call.page), Array.from({ length: TREE_PAGES_MAX }, (_, index) => index + 1));
  assert.equal(result.manifest.length, TREE_PAGES_MAX);
  assert.equal(result.deletions.length, 0);
});
