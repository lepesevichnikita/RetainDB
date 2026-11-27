import { createHash } from "node:crypto";
import { prisma, Prisma, type Transaction } from "../../db/index.js";
import { entityGraphKey, relationGraphKey, type ChunkGraph, type ChunkGraphWrite } from "../entity-graph-write.js";

// A claim is an assertion about content: it is active while the source's active version still holds
// its evidence digest. Nothing is stored about activation, so no rebind or supersede row exists.
export type ClaimOrigin = "extracted" | "import";

/** The one digest owner: a claim's evidence digest is the content hash of the chunk that asserted it. */
export function evidenceDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface ClaimEvidenceInput {
  sourceId: string;
  contentDigest: string;
  text: string;
  documentExternalId?: string | null;
  path?: string | null;
  url?: string | null;
}

export type ClaimTarget =
  | { kind: "entity"; entityId: string }
  | { kind: "relation"; relationId: string };

export interface ClaimInput {
  target: ClaimTarget;
  evidence: ClaimEvidenceInput;
  confidence: number;
  origin: ClaimOrigin;
}

export type ClaimWriter = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export interface RelationEvidence {
  snippet: string;
  sourceId: string;
  documentExternalId: string | null;
  path: string | null;
  url: string | null;
  contentDigest: string;
  confidence: number;
  origin: string;
}

/**
 * Digest membership: the claim's evidence digest must appear as a chunk's content hash inside a
 * document of the source's active version. Chunk ids do not matter (re-ingest recreates them), the
 * content hash does, which is what keeps a claim active across an unchanged re-import.
 *
 * Ruling: 05 §2 defines contentDigest as sha256 of the evidence text but activates against
 * documents.contentHash, which hashes the whole document. Anchoring on chunks.contentHash is the
 * only reading that satisfies both §2 and §6's per-claim `snippet`; see the phase ledger.
 */
export function activeClaimSql(evidence: Prisma.Sql = Prisma.sql`ev`): Prisma.Sql {
  return Prisma.sql`src."deletedAt" IS NULL AND EXISTS (
    SELECT 1 FROM documents d JOIN chunks c ON c."documentId" = d.id
    WHERE d."sourceId" = ${evidence}."sourceId" AND d."deletedAt" IS NULL
      AND d."sourceVersionId" IS NOT DISTINCT FROM src."activeVersionId"
      AND c."contentHash" = ${evidence}."contentDigest")`;
}

/** `<alias>` is the entity_relations or entities row the claim must be anchored to. */
export function claimVisibilitySql(anchor: Prisma.Sql, alias: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM claims k JOIN evidence ev ON ev.id = k."evidenceId" JOIN sources src ON src.id = ev."sourceId"
    WHERE k.${anchor} = ${alias}.id AND ${activeClaimSql(Prisma.sql`ev`)})`;
}

function claimColumns(c: ClaimInput) {
  const isEntity = c.target.kind === "entity";
  const anchor = isEntity ? (c.target as { entityId: string }).entityId : null;
  const relation = isEntity ? null : (c.target as { relationId: string }).relationId;
  return { entityId: anchor, relationId: relation, confidence: c.confidence, origin: c.origin };
}

/** One round-trip for a whole batch: evidence upserted once per digest, claims deduplicated by the partial uniques. */
export async function saveClaims(writer: ClaimWriter, inputs: readonly ClaimInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const rows = inputs.map((input) => ({ ...claimColumns(input), ...input.evidence }));
  const column = <K extends keyof (typeof rows)[number]>(key: K) => rows.map((row) => row[key] ?? null);
  const result = await writer.$queryRaw<{ count: number }[]>`
    WITH input AS (
      SELECT * FROM unnest(
        ${column("sourceId")}::text[], ${column("contentDigest")}::text[], ${column("text")}::text[],
        ${column("documentExternalId")}::text[], ${column("path")}::text[], ${column("url")}::text[],
        ${column("entityId")}::text[], ${column("relationId")}::text[],
        ${column("confidence")}::float8[], ${column("origin")}::text[])
        AS i("sourceId", "contentDigest", text, "documentExternalId", path, url, "entityId", "relationId", confidence, origin)
    ), unique_evidence AS (
      SELECT DISTINCT ON ("sourceId", "contentDigest") * FROM input ORDER BY "sourceId", "contentDigest"
    ), stored AS (
      INSERT INTO evidence ("id", "sourceId", "contentDigest", "text", "documentExternalId", "path", "url")
      SELECT gen_random_uuid()::text, u."sourceId", u."contentDigest", u.text, u."documentExternalId", u.path, u.url
      FROM unique_evidence u
      ON CONFLICT ("sourceId", "contentDigest") DO UPDATE SET text = EXCLUDED.text,
        "documentExternalId" = COALESCE(EXCLUDED."documentExternalId", evidence."documentExternalId"),
        path = COALESCE(EXCLUDED.path, evidence.path), url = COALESCE(EXCLUDED.url, evidence.url)
      RETURNING id, "sourceId", "contentDigest"
    )
    INSERT INTO claims ("id", "evidenceId", "entityId", "relationId", "confidence", "origin")
    SELECT gen_random_uuid()::text, s.id, i."entityId", i."relationId", i.confidence, i.origin
    FROM input i JOIN stored s ON s."sourceId" = i."sourceId" AND s."contentDigest" = i."contentDigest"
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return result.length;
}

export function saveClaim(writer: ClaimWriter, input: ClaimInput): Promise<number> {
  return saveClaims(writer, [input]);
}

/**
 * The one mapping from a written chunk graph to claim rows: every node and edge the graph writer
 * resolved becomes a claim under the same evidence, at the model's score or the origin's prior.
 */
export function claimInputsFromGraph(input: {
  graph: ChunkGraph;
  written: Pick<ChunkGraphWrite, "entityIds" | "relationIds">;
  evidence: ClaimEvidenceInput;
  prior: number;
  origin: ClaimOrigin;
}): ClaimInput[] {
  const { graph, written, evidence, prior, origin } = input;
  const entities = graph.entities.flatMap((entity) => {
    const entityId = written.entityIds.get(entityGraphKey(entity));
    return entityId ? [{ target: { kind: "entity" as const, entityId }, evidence, confidence: entity.confidence ?? prior, origin }] : [];
  });
  const relations = graph.relations.flatMap((relation) => {
    const from = written.entityIds.get(entityGraphKey(relation.from));
    const to = written.entityIds.get(entityGraphKey(relation.to));
    const relationId = from && to ? written.relationIds.get(relationGraphKey(from, to, relation.type)) : undefined;
    return relationId ? [{ target: { kind: "relation" as const, relationId }, evidence, confidence: relation.confidence ?? prior, origin }] : [];
  });
  return [...entities, ...relations];
}

/** Top-N evidence per relation for one hop, active claims only, in one query. */
export async function relationEvidence(
  projectId: string | undefined,
  relationIds: readonly string[],
  limit = 3,
  db: Pick<Transaction, "$queryRaw"> = prisma,
): Promise<Map<string, RelationEvidence[]>> {
  if (relationIds.length === 0) return new Map();
  const scope = projectId ? Prisma.sql`r."projectId" = ${projectId}` : Prisma.sql`true`;
  const rows = await db.$queryRaw<(RelationEvidence & { relationId: string })[]>`
    SELECT * FROM (
      SELECT c."relationId", e."text" AS snippet, e."sourceId", e."documentExternalId", e."path", e."url",
        e."contentDigest", c."confidence", c."origin",
        ROW_NUMBER() OVER (PARTITION BY c."relationId" ORDER BY c."confidence" DESC, c."id") AS slot
      FROM claims c JOIN evidence e ON e.id = c."evidenceId" JOIN sources src ON src.id = e."sourceId"
      JOIN entity_relations r ON r.id = c."relationId"
      WHERE c."relationId" = ANY(${[...relationIds]}::text[]) AND ${scope} AND ${activeClaimSql(Prisma.sql`e`)}
    ) ranked WHERE slot <= ${limit} ORDER BY "relationId", slot
  `;
  const grouped = new Map<string, RelationEvidence[]>();
  for (const { relationId, ...evidence } of rows) grouped.set(relationId, [...(grouped.get(relationId) ?? []), evidence]);
  return grouped;
}

export async function claimMetrics(): Promise<{ total: number; orphaned: number }> {
  const [row] = await prisma.$queryRaw<{ total: number; orphaned: number }[]>`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE "entityId" IS NULL AND "relationId" IS NULL)::int AS orphaned
    FROM claims
  `;
  return row;
}

/**
 * Retention: a claim whose anchors both cascaded away is garbage; a claim whose digest left every
 * document of its source is history and is dropped after the window. Evidence follows its last claim.
 */
export async function pruneClaims(params: { staleDays?: number; now?: Date } = {}): Promise<{ orphans: number; stale: number }> {
  const cutoff = new Date((params.now ?? new Date()).getTime() - (params.staleDays ?? 30) * 24 * 60 * 60 * 1000);
  return prisma.$transaction(async (tx) => {
    const orphans = await tx.$executeRaw`DELETE FROM claims WHERE "entityId" IS NULL AND "relationId" IS NULL`;
    const stale = await tx.$executeRaw`
      DELETE FROM claims k USING evidence e
      WHERE k."evidenceId" = e.id AND k."createdAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM chunks c JOIN documents d ON d.id = c."documentId"
          WHERE d."sourceId" = e."sourceId" AND c."contentHash" = e."contentDigest")`;
    await tx.$executeRaw`DELETE FROM evidence e WHERE NOT EXISTS (SELECT 1 FROM claims k WHERE k."evidenceId" = e.id)`;
    return { orphans, stale };
  });
}
