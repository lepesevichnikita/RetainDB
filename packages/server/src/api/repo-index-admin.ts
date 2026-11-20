/**
 * Repository index administration.
 *
 * Routes (mounted at the server root, all under /v1/repo-index/admin):
 *   POST /v1/repo-index/admin/scopes                                      enrol a worktree
 *   POST /v1/repo-index/admin/scopes/:scopeId/grants                      mint one scoped grant
 *   POST /v1/repo-index/admin/scopes/:scopeId/grants/:grantId/revoke      retire one grant
 *   POST /v1/repo-index/admin/scopes/:scopeId/pause                       stop serving a scope
 *   POST /v1/repo-index/admin/scopes/:scopeId/resume                      put a paused scope back
 *   POST /v1/repo-index/admin/scopes/:scopeId/withdraw                    retire a scope for good
 *
 * Authority: the credential `authMiddleware` already verified and the org it carries. Nothing
 * here reads an org from the request, and a body projectId is not authority either: it only
 * selects a project inside that org, and is refused when the org does not own it.
 *
 * A grant token is 128 random bits, hex. Its plaintext appears exactly once, in the response to
 * the call that minted it; only its sha256 digest reaches the database, and no log line or
 * refusal carries it, because `repo-index.ts` resolves a grant by `tokenHash` and nothing else.
 *
 * Minting authority: no route may mint a grant kind it cannot itself present. A kind that carries
 * the promotion decision (`PROMOTION_KINDS`, which `repo-index.ts` accepts for finalize and abandon)
 * is minted only for a caller that already presents a live grant of that kind on the same scope in
 * `X-RetainDB-Repo-Index-Grant`; anyone else answers `403 GRANT_KIND_REFUSED`. That is what keeps an
 * uploader from minting the admin grant that publishes its own upload, and it is why the deployment
 * key - a data-plane credential that cannot publish - cannot mint `admin` either. The kinds that
 * cannot publish are minted on the deployment key's authority, so enrolment stays usable.
 *
 * The first admin grant of a scope is therefore not minted here: a deployment provisions it out of
 * band with its own database access (one live row whose `tokenHash` is the sha256 of a token it
 * keeps), and that holder mints the rest. There is deliberately no request that creates the first
 * one, because such a request would be the escalation this rule exists to refuse.
 *
 * State machine, chosen so that no transition can leave the terminal state:
 *   active   --pause-->    paused      (reversible; a paused scope serves and accepts nothing)
 *   paused   --resume-->   active      (the documented way back; its grants survive the pause)
 *   active   --withdraw--> withdrawn   (terminal)
 *   paused   --withdraw--> withdrawn   (terminal; strictly narrowing, so it is allowed)
 *   paused   --pause-->    paused      (idempotent)
 *   withdrawn --withdraw--> withdrawn  (idempotent)
 *   withdrawn --pause/resume--> refused (the terminal state cannot be undone)
 *
 * A duplicate enrolment answers SCOPE_DUPLICATE with the blocking scope, so a caller that paused or
 * withdrew a worktree can see which row still owns the identity instead of guessing.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../db/index.js";
import { hashGrantToken, mintGrantToken } from "../engine/repo-index/grant-token.js";
import { resolveProjectReference } from "./helpers.js";
// The grant kinds are declared once, by the router that accepts them; this surface only mints them.
import { GRANT_KINDS } from "./repo-index.js";
import type { AuthContext } from "../middleware/auth.js";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// The token contract is defined once for this module and the repo-index router; re-exported here
// because callers and tests already import it from the admin surface.
export { hashGrantToken, mintGrantToken } from "../engine/repo-index/grant-token.js";

type Variables = { auth: AuthContext };

export const repoIndexAdminRoutes = new Hono<{ Variables: Variables }>();

/**
 * Mounts the repository index administration routes on the server's API app. Every route takes
 * its scope from the path, so registration carries no default scope.
 */
export function registerRepoIndexAdminRoutes(app: Hono<any>): void {
  app.route("/", repoIndexAdminRoutes);
}

// Same reason as in the store: the generated client can predate the repo-index models.
const db = prisma as any;

/**
 * The capabilities a grant can carry, declared once in repo-index.ts next to the capability table
 * that accepts them and re-exported here, where they are minted: `connector` is reserved for the
 * sync worker, and callers and tests already import the tuple from this surface.
 */
export { GRANT_KINDS };

/**
 * The kinds that carry the promotion decision, and therefore the only ones this surface refuses to
 * hand out on the deployment key's own authority: `repo-index.ts` accepts `admin` alone for FINALIZE
 * and ABANDON, so a grant of one of these is the right to publish an upload.
 *
 * The rule this table serves: no route may mint a grant kind it cannot itself present. A promotion
 * kind is minted only by a caller that already presents one of that kind on the same scope, which is
 * what stops an uploader from minting itself the admin grant that publishes its own upload. The
 * kinds outside this list cannot publish, so minting one on the deployment key's authority adds no
 * capability that key does not already exercise; the deployment key itself cannot publish, so it
 * cannot mint the kind that can. Keeping this list equal to CAPABILITY.FINALIZE and CAPABILITY.ABANDON
 * is pinned by the admin suite, so a new promotive kind fails there instead of reopening this.
 */
export const PROMOTION_KINDS: readonly string[] = ["admin"];

/** Header that carries a scope grant token; the same one `repo-index.ts` resolves a grant from. */
const GRANT_HEADER = "X-RetainDB-Repo-Index-Grant";

const SCOPE_STATE = {
  ACTIVE: "active",
  PAUSED: "paused",
  WITHDRAWN: "withdrawn",
} as const;

/** Every outcome this surface can report, in one place, so no route scatters its own codes. */
const CODE = {
  SCOPE_CREATED: "SCOPE_CREATED",
  SCOPE_DUPLICATE: "SCOPE_DUPLICATE",
  SCOPE_NOT_FOUND: "SCOPE_NOT_FOUND",
  SCOPE_NOT_ACTIVE: "SCOPE_NOT_ACTIVE",
  /** The row changed between the read and the fenced write into a state this action does not fit. */
  SCOPE_STATE_CHANGED: "SCOPE_STATE_CHANGED",
  PAUSE_APPLIED: "PAUSE_APPLIED",
  PAUSE_ALREADY_APPLIED: "PAUSE_ALREADY_APPLIED",
  RESUME_APPLIED: "RESUME_APPLIED",
  RESUME_ALREADY_APPLIED: "RESUME_ALREADY_APPLIED",
  WITHDRAW_APPLIED: "WITHDRAW_APPLIED",
  WITHDRAW_ALREADY_APPLIED: "WITHDRAW_ALREADY_APPLIED",
  /** Pause refused because withdraw is terminal; named for the refusal, not for the state. */
  PAUSE_REFUSED_WITHDRAWN: "PAUSE_REFUSED_WITHDRAWN",
  /** Resume refused because withdraw is terminal; a withdrawn scope cannot be brought back. */
  RESUME_REFUSED_WITHDRAWN: "RESUME_REFUSED_WITHDRAWN",
  GRANT_CREATED: "GRANT_CREATED",
  GRANT_DUPLICATE: "GRANT_DUPLICATE",
  GRANT_NOT_FOUND: "GRANT_NOT_FOUND",
  GRANT_REVOKED: "GRANT_REVOKED",
  GRANT_ALREADY_REVOKED: "GRANT_ALREADY_REVOKED",
  /** The requested kind is promotive and this caller presented no grant of that kind on the scope. */
  GRANT_KIND_REFUSED: "GRANT_KIND_REFUSED",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  ADMIN_REQUIRED: "ADMIN_REQUIRED",
} as const;

/** The outcome union, so the status table below cannot silently miss a code. */
type Code = (typeof CODE)[keyof typeof CODE];

/** One status-code table for the whole surface, keyed by every outcome above. */
const HTTP_STATUS: Record<Code, ContentfulStatusCode> = {
  [CODE.SCOPE_CREATED]: 201,
  [CODE.SCOPE_DUPLICATE]: 409,
  [CODE.SCOPE_NOT_FOUND]: 404,
  [CODE.SCOPE_NOT_ACTIVE]: 409,
  [CODE.SCOPE_STATE_CHANGED]: 409,
  [CODE.PAUSE_APPLIED]: 200,
  [CODE.PAUSE_ALREADY_APPLIED]: 200,
  [CODE.RESUME_APPLIED]: 200,
  [CODE.RESUME_ALREADY_APPLIED]: 200,
  [CODE.WITHDRAW_APPLIED]: 200,
  [CODE.WITHDRAW_ALREADY_APPLIED]: 200,
  [CODE.PAUSE_REFUSED_WITHDRAWN]: 409,
  [CODE.RESUME_REFUSED_WITHDRAWN]: 409,
  [CODE.GRANT_CREATED]: 201,
  [CODE.GRANT_DUPLICATE]: 409,
  [CODE.GRANT_NOT_FOUND]: 404,
  [CODE.GRANT_REVOKED]: 200,
  [CODE.GRANT_ALREADY_REVOKED]: 200,
  [CODE.GRANT_KIND_REFUSED]: 403,
  [CODE.PROJECT_NOT_FOUND]: 404,
  [CODE.ADMIN_REQUIRED]: 403,
};

type ScopeAction = "pause" | "resume" | "withdraw";

/**
 * Each action names the state it moves to, every state it may move from, and the answers for
 * "already there", "done" and the terminal refusal. Withdraw is idempotent, so it has no refusal.
 */
const TRANSITION: Record<
  ScopeAction,
  { to: string; from: readonly string[]; same: Code; done: Code; refused: Code | null }
> = {
  pause: {
    to: SCOPE_STATE.PAUSED,
    from: [SCOPE_STATE.ACTIVE],
    same: CODE.PAUSE_ALREADY_APPLIED,
    done: CODE.PAUSE_APPLIED,
    refused: CODE.PAUSE_REFUSED_WITHDRAWN,
  },
  resume: {
    to: SCOPE_STATE.ACTIVE,
    from: [SCOPE_STATE.PAUSED],
    same: CODE.RESUME_ALREADY_APPLIED,
    done: CODE.RESUME_APPLIED,
    refused: CODE.RESUME_REFUSED_WITHDRAWN,
  },
  withdraw: {
    to: SCOPE_STATE.WITHDRAWN,
    from: [SCOPE_STATE.ACTIVE, SCOPE_STATE.PAUSED],
    same: CODE.WITHDRAW_ALREADY_APPLIED,
    done: CODE.WITHDRAW_APPLIED,
    refused: null,
  },
};

/**
 * A trailing separator does not name a different directory, so it is not part of scope identity.
 * A Windows drive root is the exception: `C:\` is a root, and `C:` would name something else.
 */
function stripTrailingSeparators(path: string): string {
  if (/^[A-Za-z]:[\\/]$/.test(path)) return path;
  return path.replace(/[\\/]+$/, "");
}

export const scopeRequestSchema = z.object({
  projectId: z.string().trim().min(1).max(128),
  // DNS names are case-insensitive, so the unique key must not see two spellings of one host.
  repoHost: z.string().trim().toLowerCase().min(1).max(253),
  // The provider's own repository id. Case is preserved: it is not a display name, and some
  // forges distinguish repository identifiers by case.
  repoExternalId: z.string().trim().min(1).max(256),
  // One worktree, one spelling: `/w` and `/w/` are the same directory.
  worktreePath: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .transform(stripTrailingSeparators)
    .pipe(z.string().min(1)),
  deviceId: z.string().trim().min(1).max(256),
  ref: z.string().trim().min(1).max(512),
  headCommit: z.string().trim().min(1).max(128),
  policyVersion: z.string().trim().min(1).max(128),
  pipelineVersion: z.string().trim().min(1).max(128),
});

export const grantRequestSchema = z.object({
  kind: z.enum(GRANT_KINDS),
  principal: z.string().trim().min(1).max(256),
});

type ScopeRequest = z.infer<typeof scopeRequestSchema>;
type GrantRequest = z.infer<typeof grantRequestSchema>;

repoIndexAdminRoutes.post(
  "/v1/repo-index/admin/scopes",
  requireCredential,
  zValidator("json", scopeRequestSchema),
  async (c) => {
    const auth = c.get("auth");
    const body = c.req.valid("json");
    const project = await resolveProjectReference(auth.orgId, body.projectId);
    if (!project) return answer(c, CODE.PROJECT_NOT_FOUND, { projectId: body.projectId });
    const enrolment = await createScope(auth.orgId, project.id, body);
    if (!enrolment.scope) {
      // The blocking row is the answer: a paused or withdrawn scope still owns the identity, and
      // the caller cannot choose to resume it without knowing which row it is.
      return answer(c, CODE.SCOPE_DUPLICATE, enrolment.blocking ? { scope: serializeScope(enrolment.blocking) } : {});
    }
    return answer(c, CODE.SCOPE_CREATED, { scope: serializeScope(enrolment.scope) });
  },
);

repoIndexAdminRoutes.post(
  "/v1/repo-index/admin/scopes/:scopeId/grants",
  requireCredential,
  zValidator("json", grantRequestSchema),
  async (c) => {
    const auth = c.get("auth");
    const scope = await findScope(auth.orgId, pathParam(c, "scopeId"));
    if (!scope) return answer(c, CODE.SCOPE_NOT_FOUND);
    if (scope.state !== SCOPE_STATE.ACTIVE) return answer(c, CODE.SCOPE_NOT_ACTIVE, { state: scope.state });
    const body = c.req.valid("json");
    // No route may mint a grant kind it cannot itself present. A promotion kind is minted only by a
    // caller that already presents one of that kind on this scope, so the deployment key alone and
    // an uploader's own token both stop here instead of minting the grant that publishes an upload.
    // Asked before the insert, so a refusal writes no row and cannot be retried into one.
    if (PROMOTION_KINDS.includes(body.kind) && (await presentedKind(scope.id, grantToken(c))) !== body.kind) {
      return answer(c, CODE.GRANT_KIND_REFUSED, { kind: body.kind });
    }
    const minted = mintGrantToken();
    const mintedGrant = await createGrant(scope.id, body, minted.tokenHash);
    if (!mintedGrant.grant) {
      return answer(c, CODE.GRANT_DUPLICATE, {
        kind: body.kind,
        principal: body.principal,
        grant: serializeGrant(mintedGrant.blocking),
      });
    }
    // The single appearance of the plaintext: it is not stored, not logged, and never repeated.
    return answer(c, CODE.GRANT_CREATED, { grant: serializeGrant(mintedGrant.grant), token: minted.token });
  },
);

repoIndexAdminRoutes.post(
  "/v1/repo-index/admin/scopes/:scopeId/grants/:grantId/revoke",
  requireCredential,
  async (c) => {
    const auth = c.get("auth");
    const scope = await findScope(auth.orgId, pathParam(c, "scopeId"));
    if (!scope) return answer(c, CODE.SCOPE_NOT_FOUND);
    const grant = await findGrant(scope.id, pathParam(c, "grantId"));
    if (!grant) return answer(c, CODE.GRANT_NOT_FOUND);
    const result = await revokeGrant(scope.id, grant.id);
    return answer(c, result.revoked ? CODE.GRANT_REVOKED : CODE.GRANT_ALREADY_REVOKED, {
      grant: serializeGrant(result.grant),
    });
  },
);

// Pause, resume and withdraw are the same transition with a different target, refused identically
// when the scope is not this caller's. All three routes share one body so the rules stay one rule.
repoIndexAdminRoutes.post("/v1/repo-index/admin/scopes/:scopeId/pause", requireCredential, async (c) => {
  return stateAnswer(c, "pause", pathParam(c, "scopeId"));
});

repoIndexAdminRoutes.post("/v1/repo-index/admin/scopes/:scopeId/resume", requireCredential, async (c) => {
  return stateAnswer(c, "resume", pathParam(c, "scopeId"));
});

repoIndexAdminRoutes.post("/v1/repo-index/admin/scopes/:scopeId/withdraw", requireCredential, async (c) => {
  return stateAnswer(c, "withdraw", pathParam(c, "scopeId"));
});

async function stateAnswer(c: Context<{ Variables: Variables }>, action: ScopeAction, scopeId: string) {
  const result = await applyScopeTransition(db as ScopeStore, c.get("auth"), scopeId, action);
  if (!result.scope) return answer(c, result.code);
  return answer(c, result.code, { scope: serializeScope(result.scope) });
}

/**
 * Refuses a request that did not authenticate with a deployment credential.
 *
 * `authMiddleware` is the only authentication in this build. It verifies `RETAINDB_API_KEY` and
 * records `authType: "api_key"`, or records `authType: "open"` when no key is configured. This is
 * the one route that manufactures durable credentials, so open access must not reach it: an
 * unauthenticated caller would otherwise be able to enrol a worktree and mint grants.
 *
 * Keyless local development keeps working for every read path; enrolling requires setting
 * `RETAINDB_API_KEY` and sending the same `Authorization` header every other authenticated route
 * takes. There is deliberately no second opt-out flag: one bypass is already one too many.
 */
async function requireCredential(c: Context<{ Variables: Variables }>, next: Next) {
  if (c.get("auth")?.authType !== "api_key") return answer(c, CODE.ADMIN_REQUIRED);
  await next();
}

/**
 * A path parameter of this route. Hono types it as possibly absent because one router carries
 * several routes; an absent value selects no row and answers 404, which is the truthful answer.
 */
function pathParam(c: Context<{ Variables: Variables }>, name: string): string {
  return c.req.param(name) ?? "";
}

/** The scope inside this caller's org, or nothing; the org is never taken from the request. */
async function findScope(orgId: string, scopeId: string) {
  return readScope(db as ScopeStore, orgId, scopeId);
}

/** The grant token this caller presented, or nothing: the deployment key alone presents no grant. */
function grantToken(c: Context<{ Variables: Variables }>): string | undefined {
  const raw = c.req.header(GRANT_HEADER)?.trim();
  return raw ? raw : undefined;
}

/**
 * The kind of this caller's live grant on this scope, or nothing when its token resolves to no live
 * grant there. Resolved by digest, like `repo-index.ts` resolves it, so a revoked or unknown token
 * and an absent one all present no kind: a refusal tells every one of them the same thing.
 */
async function presentedKind(scopeId: string, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const grant = (await db.repoIndexGrant.findFirst({
    where: { scopeId, tokenHash: hashGrantToken(token), revokedAt: null },
    select: { kind: true },
  })) as { kind: string } | null;
  return grant?.kind ?? null;
}

async function readScope(store: ScopeStore, orgId: string, scopeId: string) {
  return (await store.repoIndexScope.findFirst({ where: { id: scopeId, orgId } })) as ScopeRow | null;
}

/** One grant of one scope, so a grant id from another scope cannot be revoked through it. */
async function findGrant(scopeId: string, grantId: string) {
  return (await db.repoIndexGrant.findFirst({ where: { id: grantId, scopeId } })) as GrantRow | null;
}

async function createScope(orgId: string, projectId: string, body: ScopeRequest) {
  try {
    const scope = (await db.repoIndexScope.create({
      data: { ...body, projectId, orgId, state: SCOPE_STATE.ACTIVE, activeGeneration: 0 },
    })) as ScopeRow;
    return { scope, blocking: null };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The unique key is (orgId, repoHost, repoExternalId, worktreePath), and `body` is already
    // normalised by scopeRequestSchema, so this selects the row that actually blocked the insert.
    const blocking = (await db.repoIndexScope.findFirst({
      where: {
        orgId,
        repoHost: body.repoHost,
        repoExternalId: body.repoExternalId,
        worktreePath: body.worktreePath,
      },
    })) as ScopeRow | null;
    return { scope: null, blocking };
  }
}

async function createGrant(scopeId: string, body: GrantRequest, tokenHash: string) {
  try {
    const grant = (await db.repoIndexGrant.create({
      data: { scopeId, kind: body.kind, principal: body.principal, tokenHash },
    })) as GrantRow;
    return { grant, blocking: null };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Only a live grant occupies the unique key: the index excludes revoked rows, so a conflict
    // here is another live credential for the same principal, not a retired row to replace.
    const blocking = (await db.repoIndexGrant.findFirst({
      where: { scopeId, kind: body.kind, principal: body.principal, revokedAt: null },
    })) as GrantRow | null;
    return { grant: null, blocking };
  }
}

/** Revokes one live grant. The `revokedAt: null` fence makes a retried revoke a no-op, not a race. */
async function revokeGrant(scopeId: string, grantId: string) {
  const { count } = await db.repoIndexGrant.updateMany({
    where: { id: grantId, scopeId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: count === 1, grant: await findGrant(scopeId, grantId) };
}

/**
 * Applies one state transition, or reports why it did not apply. Taking the table as a parameter
 * keeps the interleaving between the read and the write testable without a database: a fake table
 * that honours the update's WHERE clause reproduces a competing writer exactly.
 */
export async function applyScopeTransition(
  store: ScopeStore,
  auth: AuthContext,
  scopeId: string,
  action: ScopeAction,
): Promise<{ code: Code; scope: ScopeRow | null }> {
  const scope = await readScope(store, auth.orgId, scopeId);
  if (!scope) return { code: CODE.SCOPE_NOT_FOUND, scope: null };
  const settled = settledCode(action, scope.state);
  if (settled) return { code: settled, scope };
  const target = TRANSITION[action];
  const { count } = await store.repoIndexScope.updateMany({
    // The state this request read is part of the fence, so a competing writer that already
    // committed a different state makes this update match nothing instead of overwriting it.
    // Every source state of the action is included, not only the one just read: a pause that wins
    // first is still a legal starting point for withdraw, while a withdraw that wins first must
    // make a waiting pause match nothing.
    where: { id: scope.id, orgId: auth.orgId, state: { in: [...target.from] } },
    data: { state: target.to },
  });
  if (count === 1) return { code: target.done, scope: { ...scope, state: target.to } };
  // Lost the race. Answer from the state that actually committed, never from the stale read.
  const current = await readScope(store, auth.orgId, scopeId);
  if (!current) return { code: CODE.SCOPE_NOT_FOUND, scope: null };
  return { code: settledCode(action, current.state) ?? CODE.SCOPE_STATE_CHANGED, scope: current };
}

/**
 * The answer a state already implies for this action, or null when the action still has work to
 * do. The target answers "already applied"; a withdrawn scope answers the terminal refusal for
 * pause and resume.
 */
function settledCode(action: ScopeAction, state: string): Code | null {
  const target = TRANSITION[action];
  if (state === target.to) return target.same;
  if (state === SCOPE_STATE.WITHDRAWN) return target.refused;
  return null;
}

/** Prisma's unique-constraint code, the only duplicate signal that survives two concurrent calls. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

/** A row of repo_index_scopes, limited to the columns these routes read and answer with. */
interface ScopeRow {
  id: string;
  projectId: string;
  repoHost: string;
  repoExternalId: string;
  worktreePath: string;
  deviceId: string;
  ref: string;
  headCommit: string;
  state: string;
  policyVersion: string;
  pipelineVersion: string;
  activeGeneration: number;
}

/** The scope-table operations a transition needs, narrow enough for a test double to implement. */
interface ScopeStore {
  repoIndexScope: {
    findFirst(args: { where: { id: string; orgId: string } }): Promise<ScopeRow | null>;
    updateMany(args: { where: Record<string, unknown>; data: { state: string } }): Promise<{ count: number }>;
  };
}

interface GrantRow {
  id: string;
  scopeId: string;
  kind: string;
  principal: string;
  revokedAt: Date | null;
  createdAt: Date;
}

function serializeScope(scope: ScopeRow) {
  const { id, projectId, repoHost, repoExternalId, worktreePath, state, activeGeneration } = scope;
  const identity = { deviceId: scope.deviceId, ref: scope.ref, headCommit: scope.headCommit };
  const versions = { policyVersion: scope.policyVersion, pipelineVersion: scope.pipelineVersion };
  return { id, projectId, repoHost, repoExternalId, worktreePath, ...identity, state, ...versions, activeGeneration };
}

/** tokenHash is deliberately absent: the digest never leaves the database either. */
function serializeGrant(grant: GrantRow | null) {
  if (!grant) return null;
  const { id, scopeId, kind, principal, revokedAt, createdAt } = grant;
  return { id, scopeId, kind, principal, revokedAt, createdAt };
}

function answer(c: Context<{ Variables: Variables }>, code: Code, body: Record<string, unknown> = {}) {
  const status = HTTP_STATUS[code];
  if (status >= 400) return c.json({ success: false, error: { code, ...body } }, status);
  return c.json({ success: true, code, ...body }, status);
}
