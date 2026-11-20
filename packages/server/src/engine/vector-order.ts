import { Prisma } from "@prisma/client";

/**
 * Builds a filtered vector search whose ranking is exact for the scope it filters to.
 *
 * `ORDER BY embedding <=> $query LIMIT k` over a filtered table is answered by the planner with
 * an approximate plan when it expects the filter to be expensive: an HNSW index scan returns only
 * the tuples it visited in distance order, and every predicate above the scan (a join, an EXISTS,
 * a jsonb test) is applied to that candidate window. A scope whose rows sit outside the window
 * then answers "no matches" for content that exists and is visible - measured against pgvector
 * 0.8.7, where the same query without the ordering returns the row and with it returns none.
 *
 * The scope is therefore materialised with its distance first, and the ordering runs over that
 * computed column. The ranking then cannot be served by the vector index: it is a sort over
 * exactly the rows the filter selected, whatever plan the planner would otherwise have chosen.
 * Cost is the scope's distance computation, which is what the exact plans paid already.
 */
export function exactDistanceOrder(options: {
  table: "chunks" | "memories" | "entities";
  alias: string;
  columns: Prisma.Sql;
  scope: Prisma.Sql;
  /** Vector literal, either parameterised (a string) or inlined (Prisma.raw). */
  embedding: Prisma.Sql | string;
  limit: Prisma.Sql | number;
}): Prisma.Sql {
  const { table, alias, columns, scope, embedding, limit } = options;
  const relation = Prisma.raw(`${table} ${alias}`);
  return Prisma.sql`
    WITH scoped AS MATERIALIZED (
      SELECT ${Prisma.raw(alias)}.id AS id, (${Prisma.raw(alias)}.embedding <=> ${embedding}::vector) AS distance
      FROM ${relation}
      WHERE ${scope}
    )
    SELECT ${columns}, 1 - s.distance AS similarity
    FROM scoped s
    INNER JOIN ${relation} ON ${Prisma.raw(alias)}.id = s.id
    ORDER BY s.distance
    LIMIT ${limit}
  `;
}
