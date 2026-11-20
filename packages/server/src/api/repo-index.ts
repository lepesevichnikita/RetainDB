/**
 * Repository index API.
 *
 * Routes (mounted at the server root, all under /v1/repo-index):
 *   PUT  /v1/repo-index/scopes/:scopeId/generations/:attemptId            open an attempt
 *   PUT  /v1/repo-index/scopes/:scopeId/generations/:attemptId/parts/:partNo   store one part
 *   POST /v1/repo-index/scopes/:scopeId/generations/:attemptId/finalize   publish it
 *   POST /v1/repo-index/scopes/:scopeId/generations/:attemptId/abandon    fence it
 *   GET  /v1/repo-index/scopes/:scopeId/receipt                           read its receipt
 *   GET  /v1/repo-index/scopes/:scopeId/manifest                          read one generation
 *
 * Authority: the scope is the path parameter and nothing else. A caller proves a grant
 * on that scope with its own token in X-RetainDB-Repo-Index-Grant, because the Authorization
 * header already belongs to the deployment's API key. A reader grant may read the manifest and
 * its receipt, an uploader grant may declare an attempt and write its parts, and a connector
 * grant - the one the sync worker holds - may do both of those, because it has to read the
 * published tree to compute the next one, but may not publish or abandon it. Only an admin grant
 * may publish or abandon, so neither an uploader nor a connector can promote its own upload.
 * Every capability additionally requires the scope itself to be active: a paused scope serves
 * nothing and accepts nothing and answers SCOPE_PAUSED, a withdrawn one SCOPE_WITHDRAWN and a
 * revoked one SCOPE_REVOKED, which is the vocabulary the store and the publication fence use too.
 *
 * Searchability: finalize writes the manifest's path rows, and this route has no content of its own
 * to turn into chunks. A `content` field per manifest entry was rejected: a 10,000-entry manifest of
 * file text puts tens of megabytes into every publication, and the store records the digest it is
 * given as the document's content hash, so bytes this route cannot check against that digest would
 * label text they do not describe and the next materialisation would reuse chunks matching nothing.
 * A body flag states intent instead. `searchable: true` is refused with SEARCHABLE_UNAVAILABLE and
 * publishes nothing - the attempt stays open, and the refusal names the connector run, which reads
 * every blob at a pinned commit and materialises the generation inside the publish transaction.
 * `searchable: false`, or no flag at all, publishes metadata only and answers `searchable: false,
 * materialisedChunks: 0`. An absent flag is not a demand: metadata is the only publication this
 * route can produce, so a default that refused would answer its own default request with an error,
 * and the invariant that matters is kept by the answer - no success response ever claims
 * searchability that was not written.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db/index.js";
import { hashGrantToken } from "../engine/repo-index/grant-token.js";
import type { AuthContext } from "../middleware/auth.js";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PROMOTION_OUTCOME, scopeRefusal as refusalOfStatus } from "../engine/repo-index/receipt.js";
import {
  STORE_CODE,
  abandonAttempt,
  finalizeAttempt,
  openAttempt,
  putPart,
  readManifest,
  readReceipt,
  scopeStatusOf,
} from "../engine/repo-index/store.js";

type Variables = { auth: AuthContext };

export const repoIndexRoutes = new Hono<{ Variables: Variables }>();

/**
 * Mounts the repository index routes on the server's API app. The scope is always the
 * path parameter of the route, so registration carries no default scope.
 */
export function registerRepoIndexRoutes(app: Hono<any>): void {
  app.route("/", repoIndexRoutes);
}

// Same reason as in the store: the generated client can predate the repo-index models.
const db = prisma as any;

/** The scope grant token. A credential only; the scope itself comes from the path. */
const GRANT_HEADER = "X-RetainDB-Repo-Index-Grant";

/**
 * The grant kinds. Declared once: `repo-index-admin.ts` mints from this tuple and CAPABILITY below
 * accepts it, so neither surface can hold a kind the other does not.
 */
export const GRANT_KINDS = ["reader", "uploader", "connector", "admin"] as const;

/** One grant kind; the tuple above is the only place the set is written down. */
export type GrantKind = (typeof GRANT_KINDS)[number];

/**
 * What each route requires: a grant of any kind listed for an operation may perform it. The
 * routes read this table and nothing else, so the answer to "may this grant do this" lives in
 * one place. Every kind in GRANT_KINDS has to appear here: a kind that is mintable but that no
 * operation accepts is a credential that answers every request GRANT_MISSING.
 */
export const CAPABILITY = {
  OPEN_ATTEMPT: ["uploader", "connector"],
  PUT_PART: ["uploader", "connector"],
  FINALIZE: ["admin"],
  ABANDON: ["admin"],
  READ_RECEIPT: ["reader", "connector"],
  READ_MANIFEST: ["reader", "connector"],
} as const satisfies Record<string, readonly GrantKind[]>;

const AUTH_CODE = {
  GRANT_MISSING: "GRANT_MISSING",
} as const;

/** Refusals this route decides itself, after the caller has proved a grant on the scope. */
const ROUTE_CODE = {
  /**
   * The caller required a searchable generation and this route has no content to write chunks from.
   * Refusing keeps the demand visible; publishing metadata anyway would answer a request for search
   * results with a tree that has none. It is decided after authorize(), so a caller without a grant
   * on this scope learns GRANT_MISSING and not what this scope would accept.
   */
  SEARCHABLE_UNAVAILABLE: "SEARCHABLE_UNAVAILABLE",
} as const;

/** Every store result code in one place, so no route scatters its own HTTP numbers. */
const HTTP_STATUS: Record<string, ContentfulStatusCode> = {
  [STORE_CODE.OK]: 200,
  [STORE_CODE.PUBLISHED]: 201,
  [STORE_CODE.ATTEMPT_OPEN]: 201,
  [STORE_CODE.ATTEMPT_REPLAYED]: 200,
  [STORE_CODE.PART_ACCEPTED]: 202,
  [STORE_CODE.PART_REPLAYED]: 200,
  [STORE_CODE.ABANDONED]: 200,
  [STORE_CODE.ALREADY_ABANDONED]: 200,
  [STORE_CODE.SCOPE_NOT_FOUND]: 404,
  [STORE_CODE.SCOPE_NOT_ACTIVE]: 409,
  [STORE_CODE.ATTEMPT_NOT_FOUND]: 404,
  [STORE_CODE.ATTEMPT_CONFLICT]: 409,
  [STORE_CODE.ATTEMPT_FENCED]: 409,
  [STORE_CODE.PART_CONFLICT]: 409,
  [STORE_CODE.PART_OUT_OF_RANGE]: 400,
  [STORE_CODE.PARTS_MISSING]: 409,
  [STORE_CODE.CANNOT_ABANDON_PUBLISHED]: 409,
  [STORE_CODE.RECEIPT_NOT_PUBLISHED]: 404,
  [STORE_CODE.NO_GENERATION_PUBLISHED]: 404,
  [STORE_CODE.GENERATION_EXPIRED]: 410,
  [STORE_CODE.INVALID_CURSOR]: 400,
  [STORE_CODE.UNDECLARED_DROP]: 409,
  // Contention on a row lock, not a broken request: the caller retries the same call.
  [STORE_CODE.LOCK_TIMEOUT]: 409,
  [PROMOTION_OUTCOME.SUPERSEDED_BASE]: 409,
  [PROMOTION_OUTCOME.MISMATCHED_BASE]: 409,
  [PROMOTION_OUTCOME.MISMATCHED_SCOPE]: 409,
  [PROMOTION_OUTCOME.MISMATCHED_MANIFEST_DIGEST]: 409,
  [PROMOTION_OUTCOME.INVALID_MANIFEST]: 422,
  [PROMOTION_OUTCOME.SCOPE_REVOKED]: 403,
  [PROMOTION_OUTCOME.SCOPE_PAUSED]: 409,
  [PROMOTION_OUTCOME.SCOPE_WITHDRAWN]: 403,
  [AUTH_CODE.GRANT_MISSING]: 403,
  [ROUTE_CODE.SEARCHABLE_UNAVAILABLE]: 422,
};

const attemptSchema = z.object({
  baseGeneration: z.number().int().min(0),
  revision: z.number().int().min(1),
  manifestDigest: z.string().min(1).max(128),
  partCount: z.number().int().min(1).max(10_000),
});

const partSchema = z.object({
  upserts: z.array(z.string().min(1)).max(10_000).default([]),
  tombstones: z.array(z.string().min(1)).max(10_000).default([]),
});

const manifestPathSchema = z.object({
  path: z.string().min(1),
  digest: z.string().min(1),
  vector: z.array(z.number().finite()),
  lineStart: z.number().int().nullable().optional(),
  lineEnd: z.number().int().nullable().optional(),
});

const finalizeSchema = z.object({
  // Required, so a caller has to say which paths it expects the tree to contain; an explicit [] is
  // still allowed for a tree that is meant to be empty. The store separately refuses a manifest
  // that drops paths the attempt did not declare as tombstones.
  requiredPaths: z.array(z.string().min(1)).max(10_000),
  manifest: z.object({
    digest: z.string().min(1).max(128),
    dimensions: z.number().int().min(1),
    entries: z.array(manifestPathSchema).max(10_000),
  }),
  /**
   * Whether the caller requires the published generation to be searchable. This route has no
   * content, so `true` is refused instead of downgraded and the absence of the flag is not a
   * demand: see the module comment for the contract and why content does not travel here.
   */
  searchable: z.boolean().optional(),
});

const manifestQuerySchema = z.object({
  generation: z.coerce.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const receiptQuerySchema = z.object({
  attemptId: z.string().min(1).optional(),
});

repoIndexRoutes.put(
  "/v1/repo-index/scopes/:scopeId/generations/:attemptId",
  zValidator("json", attemptSchema),
  async (c) => {
    const scopeId = c.req.param("scopeId");
    const attemptId = c.req.param("attemptId");
    const denial = await authorize(scopeId, CAPABILITY.OPEN_ATTEMPT, grantToken(c));
    if (denial) return answer(c, denial);
    const result = await openAttempt({ scopeId, attemptId, ...c.req.valid("json") });
    return answer(c, result.code, { generationId: result.generationId, generation: result.generation });
  },
);

repoIndexRoutes.put(
  "/v1/repo-index/scopes/:scopeId/generations/:attemptId/parts/:partNo",
  zValidator("json", partSchema),
  async (c) => {
    const scopeId = c.req.param("scopeId");
    const attemptId = c.req.param("attemptId");
    const partNo = Number(c.req.param("partNo"));
    const denial = await authorize(scopeId, CAPABILITY.PUT_PART, grantToken(c));
    if (denial) return answer(c, denial);
    // After the grant, like every other refusal on this route: a stranger that sends a part number
    // this route would refuse still learns GRANT_MISSING, not what this scope accepts.
    if (!Number.isInteger(partNo) || partNo < 1) return answer(c, STORE_CODE.PART_OUT_OF_RANGE);
    const result = await putPart({ scopeId, attemptId, partNo, part: c.req.valid("json") });
    return answer(c, result.code, {
      partNo: result.partNo,
      upsertCount: result.upsertCount,
      tombstoneCount: result.tombstoneCount,
      status: result.status,
    });
  },
);

repoIndexRoutes.post(
  "/v1/repo-index/scopes/:scopeId/generations/:attemptId/finalize",
  zValidator("json", finalizeSchema),
  async (c) => {
    const scopeId = c.req.param("scopeId");
    const attemptId = c.req.param("attemptId");
    const body = c.req.valid("json");
    const denial = await authorize(scopeId, CAPABILITY.FINALIZE, grantToken(c));
    if (denial) return answer(c, denial);
    // A caller that needs search results must not be handed a publication that cannot produce any.
    // Asked after the grant, so it cannot be used to probe a scope the caller holds no grant on; it
    // names the path that does materialise, and nothing is published, so the attempt stays open.
    if (body.searchable === true) {
      return answer(c, ROUTE_CODE.SEARCHABLE_UNAVAILABLE, {
        detail: "this route publishes path metadata only; a searchable generation is published by the connector run, which reads every blob at the pinned commit",
      });
    }
    // No readContent: this route has no content of its own, so the store writes path rows only and
    // cannot raise a materialisation refusal here. What this call wrote is reported as it is: no
    // outcome means it wrote no chunk, which is what `searchable` and `materialisedChunks` say.
    const result = await finalizeAttempt({ scopeId, attemptId, requiredPaths: body.requiredPaths, manifest: body.manifest });
    return answer(c, result.code, {
      generationId: result.generationId,
      generation: result.generation,
      receiptDigest: result.receiptDigest,
      missingParts: result.missingParts,
      undeclaredDrops: result.undeclaredDrops,
      searchable: result.materialise !== undefined,
      materialisedChunks: result.materialise?.chunks ?? 0,
    });
  },
);

repoIndexRoutes.post("/v1/repo-index/scopes/:scopeId/generations/:attemptId/abandon", async (c) => {
  const scopeId = c.req.param("scopeId");
  const attemptId = c.req.param("attemptId");
  const denial = await authorize(scopeId, CAPABILITY.ABANDON, grantToken(c));
  if (denial) return answer(c, denial);
  const result = await abandonAttempt({ scopeId, attemptId });
  return answer(c, result.code, { generationId: result.generationId });
});

// The receipt of an attempt, or of the newest published generation when none is named.
repoIndexRoutes.get("/v1/repo-index/scopes/:scopeId/receipt", zValidator("query", receiptQuerySchema), async (c) => {
  const scopeId = c.req.param("scopeId");
  const denial = await authorize(scopeId, CAPABILITY.READ_RECEIPT, grantToken(c));
  if (denial) return answer(c, denial);
  const result = await readReceipt({ scopeId, attemptId: c.req.valid("query").attemptId });
  return answer(c, result.code, { receipt: result.receipt });
});

repoIndexRoutes.get(
  "/v1/repo-index/scopes/:scopeId/manifest",
  zValidator("query", manifestQuerySchema),
  async (c) => {
    const scopeId = c.req.param("scopeId");
    const denial = await authorize(scopeId, CAPABILITY.READ_MANIFEST, grantToken(c));
    if (denial) return answer(c, denial);
    const result = await readManifest({ scopeId, ...c.req.valid("query") });
    return answer(c, result.code, {
      generation: result.generation,
      entries: result.entries,
      nextCursor: result.nextCursor,
    });
  },
);

/** The grant token of this caller, or nothing; never a scope default and never a header. */
function grantToken(c: Context<{ Variables: Variables }>): string | undefined {
  const raw = c.req.header(GRANT_HEADER)?.trim();
  return raw ? raw : undefined;
}

/** The grant columns a capability check reads, plus the scope state that decides if it applies. */
interface GrantRow {
  scope: { state: string };
}

/**
 * Resolves this caller's grant for one scope and one capability. A revoked grant, an unknown
 * token and a scope that is no longer active are all refusals, so the route cannot be used to
 * probe for grants; the scope's own state decides which refusal, because paused is temporary.
 * The kinds come from CAPABILITY, so the set a token has to be in is decided in one place.
 */
async function authorize(scopeId: string, kinds: readonly string[], token: string | undefined): Promise<string | null> {
  if (!token) return AUTH_CODE.GRANT_MISSING;
  const grant = (await db.repoIndexGrant.findFirst({
    where: { scopeId, kind: { in: [...kinds] }, tokenHash: hashGrantToken(token), revokedAt: null },
    include: { scope: { select: { state: true } } },
  })) as GrantRow | null;
  if (!grant) return AUTH_CODE.GRANT_MISSING;
  return scopeRefusal(grant.scope.state);
}

/**
 * The refusal a scope's own state puts in front of every capability, or none when it is active.
 * `refusalOfStatus` is the fence's own mapping and `scopeStatusOf` the store's, so a paused scope
 * is answered as paused here, in the store and at publication, and a revoked one is never
 * reported as withdrawn.
 */
function scopeRefusal(state: string): string | null {
  return refusalOfStatus(scopeStatusOf(state)) ?? null;
}

/**
 * The status a result code answers with. HTTP_STATUS is the only place a code becomes a status, and
 * a code it does not hold is a programming error - the one case that answers 500 - so a refusal that
 * reaches a route is never reported as a broken server.
 */
export function statusForCode(code: string): ContentfulStatusCode {
  return HTTP_STATUS[code] ?? 500;
}

function answer(c: Context<{ Variables: Variables }>, code: string, body: Record<string, unknown> = {}) {
  const status = statusForCode(code);
  // Refusals carry their detail too: a caller told PARTS_MISSING needs the part numbers, and one
  // told UNDECLARED_DROP needs the paths, or it cannot make the next attempt different.
  if (status >= 400) return c.json({ success: false, error: { code, ...body } }, status);
  return c.json({ success: true, code, ...body }, status);
}
