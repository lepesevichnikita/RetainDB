/**
 * The oracle path's half of the one repository visibility rule.
 *
 * A scope is retired by changing what a reader may see, never by deleting what it published:
 * withdrawal is terminal, so the rows stay and the read path is what makes them invisible. The query
 * route applies that rule in `engine/retriever.ts`'s `visibleSourceSql`. The oracle path asks the
 * same questions of the same tables, so it applies the same predicate - written once here for the
 * oracle's queries instead of inline in each of them.
 *
 * This is not a second notion of visibility. Which scope states are readable comes from
 * `READABLE_SCOPE_STATES`, which the store derives from the same `isScopeReadable` its publish fence
 * uses, and how a scope's source is named comes from `scopeSourceName`, the function the
 * materialiser creates it with. Only the SQL shape is repeated, because the query route's predicate
 * is private to its module; the rule itself is one rule and a change to it is a change to both.
 */

import { Prisma } from "@prisma/client";
import { REPO_INDEX_SOURCE_TYPE, scopeSourceName } from "./repo-index/materialise.js";
import { READABLE_SCOPE_STATES } from "./repo-index/store.js";

/**
 * `repo-index:`, the prefix `scopeSourceName` puts in front of a scope's id. Taken from that
 * function - it is `repo-index:<scopeId>`, so an empty id leaves exactly the prefix - so this
 * predicate and the materialiser cannot disagree about how a scope's source is named.
 */
const SCOPE_SOURCE_PREFIX = scopeSourceName("");

export type ProjectSearchScope = string | { orgId: string; projectId?: string };

export function projectScopeSql(column: Prisma.Sql, scope: ProjectSearchScope) {
  if (typeof scope === "string") return Prisma.sql`${column} = ${scope}`;
  return Prisma.sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${column} AND p."orgId" = ${scope.orgId}
    ${scope.projectId ? Prisma.sql`AND p.id = ${scope.projectId}` : Prisma.empty})`;
}

/**
 * The `sources`-side scope of a repository query, over the `d` (documents) and `s` (sources) aliases
 * every caller joins.
 *
 * A row is served when its source is not a scope mirror, or when the scope that mirror names is in a
 * state a reader may see. A mirror naming no scope row is hidden too, because a missing authority is
 * not a permission. `narrowedSourceIds` is the caller's own narrowing (the request's `sourceIds`),
 * folded in ahead of the rule. Dashboard reads additionally constrain mirror ownership with `orgId`.
 */
export function visibleSourceSql(narrowedSourceIds: readonly string[] = [], orgId?: string): Prisma.Sql {
  const narrowed = narrowedSourceIds.length > 0
    ? Prisma.sql`AND d."sourceId" = ANY(${[...narrowedSourceIds]})`
    : Prisma.empty;
  return Prisma.sql`${narrowed}AND (
      s.type <> ${REPO_INDEX_SOURCE_TYPE}
      OR EXISTS (
        SELECT 1
        FROM repo_index_scopes visible_scope
        WHERE visible_scope."projectId" = s."projectId"
          ${orgId === undefined ? Prisma.empty : Prisma.sql`AND visible_scope."orgId" = ${orgId}`}
          AND s.name = ${SCOPE_SOURCE_PREFIX} || visible_scope.id
          AND visible_scope.state = ANY(${READABLE_SCOPE_STATES})
      )
    )`;
}
