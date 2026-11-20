import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMBEDDING_DIMENSIONS,
  PROMOTION_OUTCOME,
  isScopeReadable,
  isUsableVector,
  promoteAttempt,
} from "../src/engine/repo-index/receipt.js";

const DIMENSIONS = 1024;

function vector(fill = 0.5): number[] {
  return Array<number>(DIMENSIONS).fill(fill);
}

function activeScope() {
  return { scopeId: "repo-1", generation: 7, revision: 3, manifestDigest: "digest-7-3", status: "active" as const };
}

function attempt(baseGeneration: number, revision: number) {
  return { scopeId: "repo-1", attemptId: `attempt-${baseGeneration}-${revision}`, baseGeneration, revision, manifestDigest: `digest-${revision}` };
}

// An attempt carries the digest of the manifest it published, so the manifest a revision 4
// attempt promotes defaults to digest-4.
function manifestFor(digest: string, ...paths: string[]) {
  return { digest, dimensions: DIMENSIONS, entries: paths.map((path) => ({ path, vector: vector() })) };
}

function manifest(...paths: string[]) {
  return manifestFor("digest-4", ...paths);
}

// Behaviour: a full-width finite vector is the only shape semantic search can use.
test("a 1024-dimension finite vector is usable", () => {
  assert.equal(isUsableVector(vector(), DIMENSIONS), true);
});

// Behaviour: an empty array is truthy but stores no recall, so it must be refused.
test("an empty vector is not usable", () => {
  assert.equal(isUsableVector([], DIMENSIONS), false);
});

// Behaviour: a non-array answer from an embedder must be refused, not coerced. A null answer is
// the common failure shape of a failed JSON decode.
test("a non-array vector is not usable", () => {
  assert.equal(isUsableVector(undefined, DIMENSIONS), false);
  assert.equal(isUsableVector(null, DIMENSIONS), false);
  assert.equal(isUsableVector("0.1,0.2", DIMENSIONS), false);
  assert.equal(isUsableVector({ length: DIMENSIONS }, DIMENSIONS), false);
});

// Behaviour: NaN and Infinity poison distance maths, so one bad element refuses the vector.
test("a vector with a non-finite element is not usable", () => {
  const withNaN = vector();
  withNaN[17] = Number.NaN;
  const withInfinity = vector();
  withInfinity[0] = Number.POSITIVE_INFINITY;
  assert.equal(isUsableVector(withNaN, DIMENSIONS), false);
  assert.equal(isUsableVector(withInfinity, DIMENSIONS), false);
});

// Behaviour: a wrong-width vector cannot be stored in a vector(1024) column.
test("a wrong-length vector is not usable", () => {
  assert.equal(isUsableVector([1, 2, 3], DIMENSIONS), false);
  assert.equal(isUsableVector(vector().slice(1), DIMENSIONS), false);
  assert.equal(isUsableVector([...vector(), 0], DIMENSIONS), false);
});

// Behaviour: `new Array(1024)` is full of holes, and a hole is not a number. Array.prototype.every
// skips holes, so a sparse vector used to slip past the fence and reach pgvector as "1,,,...".
test("a sparse vector with holes is not usable", () => {
  const sparse = new Array<number>(DIMENSIONS);
  sparse[0] = 1;
  assert.equal(isUsableVector(sparse, DIMENSIONS), false);
});

// Behaviour: an attempt that starts from the active generation may publish its revision.
test("an attempt built on the active generation is promoted", () => {
  const result = promoteAttempt({
    active: activeScope(),
    attempt: attempt(7, 4),
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.PROMOTED);
  assert.equal(result.active.generation, 8);
  assert.equal(result.active.revision, 4);
  assert.equal(result.active.manifestDigest, "digest-4");
});

// Behaviour: promotion is pure, so the caller's active generation is not rewritten in place.
test("promotion leaves the supplied active generation untouched", () => {
  const active = activeScope();
  const result = promoteAttempt({ active, attempt: attempt(7, 4), manifest: manifest("src/index.ts"), requiredPaths: ["src/index.ts"] });
  // Without this, the test passes just as well when promotion is refused and nothing is written.
  assert.equal(result.outcome, PROMOTION_OUTCOME.PROMOTED);
  assert.equal(active.generation, 7);
  assert.equal(active.revision, 3);
  assert.equal(active.manifestDigest, "digest-7-3");
});

// Behaviour: a receipt issued for one scope never publishes into another scope, even when
// its base generation and its manifest are valid, and the active generation keeps serving.
test("an attempt issued for another scope is refused as mismatched scope", () => {
  const active = activeScope();
  const result = promoteAttempt({
    active,
    attempt: { ...attempt(7, 4), scopeId: "repo-2" },
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.MISMATCHED_SCOPE);
  assert.deepEqual(result.active, active);
});

// Behaviour: the digest recorded on the promoted generation must be the digest of the
// manifest that was validated, so a receipt naming another manifest is refused.
test("an attempt whose manifest digest differs from the manifest is refused as mismatched digest", () => {
  const active = activeScope();
  const result = promoteAttempt({
    active,
    attempt: { ...attempt(7, 4), manifestDigest: "digest-other" },
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.MISMATCHED_MANIFEST_DIGEST);
  assert.deepEqual(result.active, active);
});

// Behaviour: a decoded payload can lose its scope id; two missing ids are not a match, so the
// attempt is refused instead of publishing into an unnamed scope.
test("a payload with no scope ids is refused as mismatched scope", () => {
  const active = { ...activeScope(), scopeId: undefined as unknown as string };
  const result = promoteAttempt({
    active,
    attempt: { ...attempt(7, 4), scopeId: undefined as unknown as string },
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.MISMATCHED_SCOPE);
  assert.equal(result.active.generation, 7);
});

// Behaviour: the same for the digest: two missing digests must not compare equal and record a
// generation whose digest is not a string.
test("a payload with no manifest digests is refused as mismatched digest", () => {
  const result = promoteAttempt({
    active: activeScope(),
    attempt: { ...attempt(7, 4), manifestDigest: undefined as unknown as string },
    manifest: { ...manifest("src/index.ts"), digest: undefined as unknown as string },
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.MISMATCHED_MANIFEST_DIGEST);
  assert.equal(result.active.generation, 7);
});

// Behaviour: an older attempt promoting over a newer generation is refused, and the
// refusal is distinguishable from every other refusal.
test("an attempt on an older generation is refused as superseded", () => {
  const result = promoteAttempt({
    active: { ...activeScope(), generation: 9, revision: 5, manifestDigest: "digest-9-5" },
    attempt: attempt(7, 4),
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.SUPERSEDED_BASE);
  assert.notEqual(result.outcome, PROMOTION_OUTCOME.PROMOTED);
  assert.equal(result.active.generation, 9);
  assert.equal(result.active.manifestDigest, "digest-9-5");
});

// Behaviour: a base generation that never existed is refused separately from an
// older one, because the operator action differs.
test("an attempt on an unknown future generation is refused as mismatched", () => {
  const result = promoteAttempt({
    active: activeScope(),
    attempt: attempt(11, 4),
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.MISMATCHED_BASE);
  assert.equal(result.active.generation, 7);
});

// Behaviour: a manifest that does not cover every required path cannot replace the
// active generation, so the previous generation keeps serving reads.
test("a manifest missing a required entry is refused and the previous generation stays active", () => {
  const active = activeScope();
  const result = promoteAttempt({
    active,
    attempt: attempt(7, 4),
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts", "src/receipt.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.INVALID_MANIFEST);
  assert.deepEqual(result.active, active);
});

// Behaviour: a manifest entry carrying a wrong-width or non-finite vector is refused,
// because publishing it would advertise content the index cannot serve.
test("a manifest entry with an unusable vector is refused and the previous generation stays active", () => {
  const active = activeScope();
  const shortVector = { ...manifest("src/index.ts"), entries: [{ path: "src/index.ts", vector: [1, 2, 3] }] };
  const result = promoteAttempt({ active, attempt: attempt(7, 4), manifest: shortVector, requiredPaths: ["src/index.ts"] });
  assert.equal(result.outcome, PROMOTION_OUTCOME.INVALID_MANIFEST);
  assert.deepEqual(result.active, active);

  const emptyVector = { ...manifest("src/index.ts"), entries: [{ path: "src/index.ts", vector: [] }] };
  const empty = promoteAttempt({ active, attempt: attempt(7, 4), manifest: emptyVector, requiredPaths: ["src/index.ts"] });
  assert.equal(empty.outcome, PROMOTION_OUTCOME.INVALID_MANIFEST);
  assert.deepEqual(empty.active, active);
});

// Behaviour: cosine distance against an all-zero vector is NaN, so a manifest entry of
// zeros carries no recall and publishing it would advertise an unsearchable chunk.
test("a manifest entry with an all-zero vector is refused and the previous generation stays active", () => {
  // Directly too: an all-zero dense vector has no direction, so cosine distance is NaN.
  assert.equal(isUsableVector(new Array<number>(DIMENSIONS).fill(0), DIMENSIONS), false);
  const active = activeScope();
  const zeroVector = { ...manifest("src/index.ts"), entries: [{ path: "src/index.ts", vector: vector(0) }] };
  const result = promoteAttempt({ active, attempt: attempt(7, 4), manifest: zeroVector, requiredPaths: ["src/index.ts"] });
  assert.equal(result.outcome, PROMOTION_OUTCOME.INVALID_MANIFEST);
  assert.deepEqual(result.active, active);
});

// Behaviour: rejecting zeros must not reject a real retrieval vector, so unit-scale and signed
// embeddings stay usable and their manifest is promoted.
test("a legitimate non-zero vector is still accepted", () => {
  const unitScale = Array<number>(DIMENSIONS).fill(1 / Math.sqrt(DIMENSIONS));
  assert.equal(isUsableVector(unitScale, DIMENSIONS), true);

  // Real embeddings are signed; a negative component is a direction, not a defect.
  const signed = vector();
  signed[5] = -0.25;
  assert.equal(isUsableVector(signed, DIMENSIONS), true);

  const result = promoteAttempt({
    active: activeScope(),
    attempt: attempt(7, 4),
    manifest: { ...manifest("src/index.ts"), entries: [{ path: "src/index.ts", vector: unitScale }] },
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.PROMOTED);
});

// Behaviour: chunks.embedding is vector(1024), so a manifest that declares a narrower width,
// even with vectors of that width, cannot be stored and must not replace the active generation.
test("a manifest declaring a width other than the store width is refused", () => {
  const active = activeScope();
  const narrow = { ...manifest("src/index.ts"), dimensions: 3, entries: [{ path: "src/index.ts", vector: [1, 2, 3] }] };
  const result = promoteAttempt({ active, attempt: attempt(7, 4), manifest: narrow, requiredPaths: ["src/index.ts"] });
  assert.equal(result.outcome, PROMOTION_OUTCOME.INVALID_MANIFEST);
  assert.deepEqual(result.active, active);
});

// Behaviour: the store column is vector(1024). If this constant drifted, every vector stored or
// published would be the wrong width for the column, so pin it to the schema.
test("the shared embedding width matches the vector(1024) column", () => {
  assert.equal(EMBEDDING_DIMENSIONS, 1024);
});

// Behaviour: a path that appears twice describes one chunk twice, so the manifest is
// ambiguous and cannot replace the active generation.
test("a manifest with a duplicated path is refused", () => {
  const active = activeScope();
  const result = promoteAttempt({
    active,
    attempt: attempt(7, 4),
    manifest: manifestFor("digest-4", "src/index.ts", "src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.INVALID_MANIFEST);
  assert.deepEqual(result.active, active);
});

// Behaviour: two distinct usable entries that cover the required paths are a valid
// manifest, so counting distinct paths must not refuse it.
test("a manifest with two distinct usable entries covering the required paths is promoted", () => {
  const result = promoteAttempt({
    active: activeScope(),
    attempt: attempt(7, 4),
    manifest: manifest("src/index.ts", "src/receipt.ts"),
    requiredPaths: ["src/index.ts", "src/receipt.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.PROMOTED);
  assert.equal(result.active.generation, 8);
  assert.equal(result.active.manifestDigest, "digest-4");
});

// Behaviour: a revoked scope accepts no write.
test("a revoked scope refuses promotion", () => {
  const result = promoteAttempt({
    active: { ...activeScope(), status: "revoked" },
    attempt: attempt(7, 4),
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.SCOPE_REVOKED);
  assert.equal(result.active.status, "revoked");
  assert.equal(result.active.generation, 7);
});

// Behaviour: a withdrawn scope accepts no write.
test("a withdrawn scope refuses promotion", () => {
  const result = promoteAttempt({
    active: { ...activeScope(), status: "withdrawn" },
    attempt: attempt(7, 4),
    manifest: manifest("src/index.ts"),
    requiredPaths: ["src/index.ts"],
  });
  assert.equal(result.outcome, PROMOTION_OUTCOME.SCOPE_WITHDRAWN);
  assert.equal(result.active.status, "withdrawn");
});

// Behaviour: revoked and withdrawn scopes disappear from reads, an active scope does not.
test("revoked and withdrawn scopes are invisible to reads", () => {
  assert.equal(isScopeReadable({ ...activeScope(), status: "active" }), true);
  assert.equal(isScopeReadable({ ...activeScope(), status: "revoked" }), false);
  assert.equal(isScopeReadable({ ...activeScope(), status: "withdrawn" }), false);
});
