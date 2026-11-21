/**
 * Repository index publication rules.
 *
 * Pure functions over plain data: they decide whether an attempt may replace the
 * generation readers currently see. No database access and no side effects, so a
 * refusal is a value the caller can map to an HTTP or CLI answer.
 */

export const PROMOTION_OUTCOME = {
  PROMOTED: "PROMOTED",
  MISMATCHED_SCOPE: "MISMATCHED_SCOPE",
  MISMATCHED_MANIFEST_DIGEST: "MISMATCHED_MANIFEST_DIGEST",
  SUPERSEDED_BASE: "SUPERSEDED_BASE",
  MISMATCHED_BASE: "MISMATCHED_BASE",
  INVALID_MANIFEST: "INVALID_MANIFEST",
  SCOPE_REVOKED: "SCOPE_REVOKED",
  SCOPE_PAUSED: "SCOPE_PAUSED",
  SCOPE_WITHDRAWN: "SCOPE_WITHDRAWN",
} as const;

export type PromotionOutcome = (typeof PROMOTION_OUTCOME)[keyof typeof PROMOTION_OUTCOME];

/** The states a scope row can carry; anything else is a state this module does not know. */
export type ScopeStatus = "active" | "paused" | "revoked" | "withdrawn";

export interface ScopeState {
  scopeId: string;
  generation: number;
  revision: number;
  manifestDigest: string | null;
  status: ScopeStatus;
}

export interface AttemptReceipt {
  scopeId: string;
  attemptId: string;
  baseGeneration: number;
  revision: number;
  manifestDigest: string;
}

export interface ManifestEntry {
  path: string;
  vector: number[];
}

export interface Manifest {
  digest: string;
  dimensions: number;
  entries: ManifestEntry[];
}

export interface PromotionRequest {
  active: ScopeState;
  attempt: AttemptReceipt;
  manifest: Manifest;
  requiredPaths: string[];
}

export interface PromotionResult {
  outcome: PromotionOutcome;
  active: ScopeState;
}

/**
 * The width of chunks.embedding (vector(1024)). A vector of any other width cannot be stored, so
 * this is the single authority both the publication fence and ingestion validate against.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * A vector is usable only when semantic search can consume it: a real array, at the width the
 * store expects, with finite numbers and at least one non-zero element. An empty array is truthy
 * but carries no recall, which is how a searchable chunk once lost its embedding, and an all-zero
 * vector makes cosine distance NaN in pgvector. Iterate instead of calling every/some: both skip
 * array holes, so a sparse array would pass the fence and reach pgvector as "1,,,...".
 */
export function isUsableVector(vector: unknown, dimensions: number): boolean {
  if (!Array.isArray(vector) || vector.length !== dimensions) return false;
  let hasNonZero = false;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (value !== 0) hasNonZero = true;
  }
  return hasNonZero;
}

export function isScopeReadable(scope: ScopeState): boolean {
  return scope.status === "active";
}

export function promoteAttempt({ active, attempt, manifest, requiredPaths }: PromotionRequest): PromotionResult {
  const refusal =
    scopeIdentityRefusal(active, attempt) ??
    manifestDigestRefusal(attempt, manifest) ??
    scopeRefusal(active.status) ??
    baseRefusal(active, attempt) ??
    manifestRefusal(manifest, requiredPaths);
  if (refusal) return { outcome: refusal, active };
  return {
    outcome: PROMOTION_OUTCOME.PROMOTED,
    active: {
      ...active,
      generation: active.generation + 1,
      revision: attempt.revision,
      manifestDigest: attempt.manifestDigest,
    },
  };
}

// A decoded payload can arrive without a field. Two missing values are not one identity, so both
// sides must be strings before equality means anything.
function sameText(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left === right;
}

function scopeIdentityRefusal(active: ScopeState, attempt: AttemptReceipt): PromotionOutcome | undefined {
  return sameText(attempt.scopeId, active.scopeId) ? undefined : PROMOTION_OUTCOME.MISMATCHED_SCOPE;
}

function manifestDigestRefusal(attempt: AttemptReceipt, manifest: Manifest): PromotionOutcome | undefined {
  return sameText(attempt.manifestDigest, manifest.digest) ? undefined : PROMOTION_OUTCOME.MISMATCHED_MANIFEST_DIGEST;
}

/**
 * The refusal a scope's own state puts in front of every capability, or none while it is active.
 * This is the one place a state becomes a code: the fence, the store and the API all ask here, so
 * a paused scope is never reported as revoked and a withdrawal never as a pause.
 */
export function scopeRefusal(status: ScopeStatus): PromotionOutcome | undefined {
  if (status === "active") return undefined;
  if (status === "paused") return PROMOTION_OUTCOME.SCOPE_PAUSED;
  return status === "withdrawn" ? PROMOTION_OUTCOME.SCOPE_WITHDRAWN : PROMOTION_OUTCOME.SCOPE_REVOKED;
}

/**
 * The base-generation refusal, exported because the seal is not the only place that can answer it:
 * staging asks the same question before it reads a tree, so a publication that can never be sealed
 * does not read, chunk, embed and write it first.
 */
export function baseRefusal(active: ScopeState, attempt: AttemptReceipt): PromotionOutcome | undefined {
  if (attempt.baseGeneration === active.generation) return undefined;
  return attempt.baseGeneration < active.generation
    ? PROMOTION_OUTCOME.SUPERSEDED_BASE
    : PROMOTION_OUTCOME.MISMATCHED_BASE;
}

function manifestRefusal(manifest: Manifest, requiredPaths: string[]): PromotionOutcome | undefined {
  if (manifest.dimensions !== EMBEDDING_DIMENSIONS) return PROMOTION_OUTCOME.INVALID_MANIFEST;
  const paths = manifest.entries.map((entry) => entry.path);
  const pathSet = new Set(paths);
  const everyPathDistinct = pathSet.size === paths.length;
  const everyEntryUsable = manifest.entries.every((entry) => isUsableVector(entry.vector, EMBEDDING_DIMENSIONS));
  const everyRequirementCovered = requiredPaths.every((path) => pathSet.has(path));
  return everyPathDistinct && everyEntryUsable && everyRequirementCovered ? undefined : PROMOTION_OUTCOME.INVALID_MANIFEST;
}
