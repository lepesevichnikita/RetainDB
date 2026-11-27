import { z } from "zod";
import { prisma, Prisma } from "../db/index.js";

type GraphWriter = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export const entityRelationType = z.enum([
  "imports", "exports", "calls", "implements", "extends", "references",
  "depends_on", "related_to", "part_of", "contradicts", "supersedes",
]);

type RelationType = z.infer<typeof entityRelationType>;

export type GraphOrigin = "manual" | "extracted" | "import";

/** Conflict precedence: manual > import > extracted. A writer may only replace its own origin. */
const originPrecedence: Record<GraphOrigin, number> = { extracted: 0, import: 1, manual: 2 };

type EntityKey = { name: string; entityType: string };
type EntityIdentity = EntityKey & { projectId: string };
type EntityInput = EntityIdentity & { description?: string; metadata?: Prisma.InputJsonObject };

interface RelationInput {
  projectId: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: RelationType;
  weight?: number;
  metadata?: Prisma.InputJsonObject;
  sourceChunkId?: string;
}

export interface ChunkGraph {
  entities: (EntityKey & { description?: string; confidence?: number })[];
  relations: { from: EntityKey; to: EntityKey; type: RelationType; confidence?: number }[];
}

export function vectorLiteral(vector: readonly number[]) {
  return `[${vector.join(",")}]`;
}

function jsonMetadata(metadata: Prisma.InputJsonObject | undefined) {
  return metadata === undefined ? null : JSON.stringify(metadata);
}

export async function saveGraphEntity(input: EntityInput) {
  const id = await writeManualEntity(input);
  await refreshEntityVectors(prisma, [id]);
  return prisma.entity.findUniqueOrThrow({ where: { id }, select: {
    id: true, documentId: true, projectId: true, name: true, type: true, entityType: true,
    description: true, aliases: true, metadata: true, createdAt: true, updatedAt: true,
  } });
}

async function writeManualEntity(input: EntityInput) {
  const { projectId, name, entityType, description, metadata } = input;
  const json = jsonMetadata(metadata);
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", description, metadata, "isManual", origin, embedding, "updatedAt")
    VALUES (gen_random_uuid()::text, ${projectId}, ${name}, ${entityType}, ${entityType}, ${description ?? null},
      COALESCE(${json}::jsonb, '{}'::jsonb), true, 'manual', NULL, NOW())
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET
      description = COALESCE(EXCLUDED.description, CASE WHEN entities."isManual" THEN entities.description END),
      metadata = COALESCE(${json}::jsonb, entities.metadata),
      "isManual" = true, origin = 'manual', "updatedAt" = NOW()
    RETURNING id
  `;
  return row.id;
}

/** A node created for a machine writer (origin excludes manual, so isManual is false): it never promotes or overwrites an existing row. */
async function createMachineEntity(identity: EntityIdentity, origin: Exclude<GraphOrigin, "manual">) {
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", origin, "updatedAt")
    VALUES (gen_random_uuid()::text, ${identity.projectId}, ${identity.name}, ${identity.entityType}, ${identity.entityType}, false, ${origin}, NOW())
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  return row.id;
}

export async function ensureGraphEntityId(identity: EntityIdentity, origin: GraphOrigin) {
  const existing = await prisma.entity.findUnique({
    where: { projectId_name_entityType: identity }, select: { id: true },
  });
  if (existing) return existing.id;
  return origin === "manual" ? writeManualEntity(identity) : createMachineEntity(identity, origin);
}

/**
 * A node's vector is the centroid of the chunk vectors that mention it: the content was
 * already embedded on ingest, so the graph never calls the embedding model.
 */
export async function refreshEntityVectors(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  entityIds: readonly string[],
) {
  if (entityIds.length === 0) return 0;
  const updated = await tx.$executeRaw`
    UPDATE entities e
    SET embedding = m.centroid, "updatedAt" = NOW()
    FROM (
      SELECT em."entityId" AS id, avg(c.embedding) AS centroid
      FROM entity_mentions em
      JOIN chunks c ON c.id = em."chunkId"
      WHERE em."entityId" = ANY(${[...entityIds]}::text[]) AND c.embedding IS NOT NULL
      GROUP BY em."entityId"
    ) m
    WHERE e.id = m.id AND (e.embedding IS NULL OR e.embedding IS DISTINCT FROM m.centroid)
  `;
  return updated;
}

export function saveGraphRelation(input: RelationInput) {
  const { fromEntityId, toEntityId, relationType, weight, metadata, sourceChunkId } = input;
  const manual = { origin: "manual", isManual: true };
  return prisma.entityRelation.upsert({
    where: { fromEntityId_toEntityId_relationType: { fromEntityId, toEntityId, relationType } },
    update: { projectId: input.projectId, weight, metadata, sourceChunkId, ...manual },
    create: { ...input, ...manual },
    select: { id: true, projectId: true, fromEntityId: true, toEntityId: true,
      relationType: true, weight: true, metadata: true, sourceChunkId: true, createdAt: true },
  });
}

function graphOriginRank(origin: GraphOrigin) {
  return originPrecedence[origin];
}

/** Stable key for a node inside one project graph, shared with the claim writer. */
export function entityGraphKey({ name, entityType }: EntityKey) {
  return JSON.stringify([entityType, name]);
}

/** Stable key for an edge, so a caller can map its own relations back to stored ids. */
export function relationGraphKey(fromEntityId: string, toEntityId: string, relationType: string) {
  return JSON.stringify([fromEntityId, toEntityId, relationType]);
}

function uniqueClaims(graph: ChunkGraph) {
  const entries = new Map(graph.entities.map((entity) => [entityGraphKey(entity), entity]));
  return [...entries.keys()].sort().flatMap((key) => entries.get(key) ?? []);
}

async function claimChunk(tx: GraphWriter, projectId: string, chunkId: string) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM chunks c JOIN documents d ON d.id = c."documentId" JOIN sources s ON s.id = d."sourceId"
    WHERE c.id = ${chunkId} AND c."projectId" = ${projectId} AND s."projectId" = ${projectId}
    FOR NO KEY UPDATE OF c
  `;
  return Boolean(row);
}

/**
 * A mention never owns the node: it may only raise the row's origin (manual > import > extracted).
 * It writes neither description nor metadata, so a manual row keeps both on conflict.
 */
async function putEntityMention(tx: GraphWriter, projectId: string, chunkId: string, entity: ChunkGraph["entities"][number], origin: GraphOrigin) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", origin, "updatedAt")
    VALUES (gen_random_uuid()::text, ${projectId}, ${entity.name}, ${entity.entityType}, ${entity.entityType}, ${origin === "manual"}, ${origin}, NOW())
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET
      origin = CASE WHEN ${graphOriginRank(origin)} >= (CASE entities.origin WHEN 'manual' THEN 2 WHEN 'import' THEN 1 ELSE 0 END)
        THEN EXCLUDED.origin ELSE entities.origin END,
      "isManual" = CASE WHEN ${graphOriginRank(origin)} >= (CASE entities.origin WHEN 'manual' THEN 2 WHEN 'import' THEN 1 ELSE 0 END)
        THEN EXCLUDED."isManual" ELSE entities."isManual" END
    RETURNING id
  `;
  await tx.$executeRaw`
    INSERT INTO entity_mentions ("entityId", "chunkId", description)
    VALUES (${row.id}, ${chunkId}, ${entity.description ?? null})
    ON CONFLICT ("entityId", "chunkId") DO UPDATE
    SET description = EXCLUDED.description
  `;
  return row.id;
}

type ResolvedEdge = Pick<RelationInput, "fromEntityId" | "toEntityId" | "relationType">;

function resolveEdges(relations: ChunkGraph["relations"], ids: Map<string, string>) {
  const edges = new Map<string, ResolvedEdge>();
  for (const { from, to, type } of relations) {
    const origin = ids.get(entityGraphKey(from));
    const target = ids.get(entityGraphKey(to));
    if (origin && target) edges.set(JSON.stringify([origin, target, type]), { fromEntityId: origin, toEntityId: target, relationType: type });
  }
  return [...edges.keys()].sort().flatMap((key) => edges.get(key) ?? []);
}

/** A machine edge never writes weight or metadata; a manual row keeps both on conflict. */
async function putRelationMention(tx: GraphWriter, projectId: string, chunkId: string, edge: ResolvedEdge, origin: GraphOrigin) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO entity_relations (id, "projectId", "fromEntityId", "toEntityId", "relationType", "sourceChunkId", "isManual", origin)
    VALUES (gen_random_uuid()::text, ${projectId}, ${edge.fromEntityId}, ${edge.toEntityId}, ${edge.relationType}, ${chunkId}, ${origin === "manual"}, ${origin})
    ON CONFLICT ("fromEntityId", "toEntityId", "relationType") DO UPDATE SET
      origin = CASE WHEN ${graphOriginRank(origin)} >= (CASE entity_relations.origin WHEN 'manual' THEN 2 WHEN 'import' THEN 1 ELSE 0 END)
        THEN EXCLUDED.origin ELSE entity_relations.origin END,
      "isManual" = CASE WHEN ${graphOriginRank(origin)} >= (CASE entity_relations.origin WHEN 'manual' THEN 2 WHEN 'import' THEN 1 ELSE 0 END)
        THEN EXCLUDED."isManual" ELSE entity_relations."isManual" END,
      "sourceChunkId" = COALESCE(entity_relations."sourceChunkId", EXCLUDED."sourceChunkId")
    RETURNING id
  `;
  await tx.$executeRaw`
    INSERT INTO entity_relation_mentions ("relationId", "chunkId") VALUES (${row.id}, ${chunkId}) ON CONFLICT DO NOTHING
  `;
  return row.id;
}

type ChunkGraphWriteMode = "replace" | "merge";

export interface ChunkGraphWrite {
  entities: number;
  relations: number;
  entityIds: Map<string, string>;
  relationIds: Map<string, string>;
}

const emptyGraphWrite = (): ChunkGraphWrite => ({ entities: 0, relations: 0, entityIds: new Map(), relationIds: new Map() });

async function writeChunkClaims(tx: GraphWriter, projectId: string, chunkId: string, graph: ChunkGraph, mode: ChunkGraphWriteMode, origin: GraphOrigin): Promise<ChunkGraphWrite> {
  const entityIds = new Map<string, string>();
  for (const entity of uniqueClaims(graph)) {
    entityIds.set(entityGraphKey(entity), await putEntityMention(tx, projectId, chunkId, entity, origin));
  }
  const relationIds = new Map<string, string>();
  for (const edge of resolveEdges(graph.relations, entityIds)) {
    const key = relationGraphKey(edge.fromEntityId, edge.toEntityId, edge.relationType);
    relationIds.set(key, await putRelationMention(tx, projectId, chunkId, edge, origin));
  }
  if (mode === "replace") await pruneOmittedMentions(tx, chunkId, [...relationIds.values()], [...entityIds.values()]);
  await refreshEntityVectors(tx, [...entityIds.values()]);
  return { entities: entityIds.size, relations: relationIds.size, entityIds, relationIds };
}

async function pruneOmittedMentions(tx: GraphWriter, chunkId: string, relationIds: string[], entityIds: string[]) {
  await tx.$executeRaw`DELETE FROM entity_relation_mentions WHERE "chunkId" = ${chunkId} AND NOT ("relationId" = ANY(${relationIds}::text[]))`;
  await tx.$executeRaw`DELETE FROM entity_mentions WHERE "chunkId" = ${chunkId} AND NOT ("entityId" = ANY(${entityIds}::text[]))`;
}

export async function saveChunkGraph(projectId: string, chunkId: string, graph: ChunkGraph, origin: GraphOrigin, transaction?: GraphWriter, mode: ChunkGraphWriteMode = "replace"): Promise<ChunkGraphWrite> {
  const save = async (tx: GraphWriter) => {
    if (!await claimChunk(tx, projectId, chunkId)) return emptyGraphWrite();
    return writeChunkClaims(tx, projectId, chunkId, graph, mode, origin);
  };
  return transaction ? save(transaction) : prisma.$transaction(save);
}

export interface BatchGraphInput {
  entities: (EntityKey & { description?: string })[];
  relations: { from: EntityKey; to: EntityKey; type: RelationType; sourceChunkId?: string }[];
}

function batchEntities(input: BatchGraphInput) {
  const unique = new Map<string, EntityKey & { description?: string }>();
  for (const entity of input.entities) unique.set(entityGraphKey(entity), entity);
  for (const relation of input.relations) {
    unique.set(entityGraphKey(relation.from), relation.from);
    unique.set(entityGraphKey(relation.to), relation.to);
  }
  return [...unique.values()];
}

async function upsertBatchEntities(tx: GraphWriter, projectId: string, entities: ReturnType<typeof batchEntities>) {
  if (entities.length === 0) return new Map<string, string>();
  const names = entities.map((entity) => entity.name);
  const types = entities.map((entity) => entity.entityType);
  const descriptions = entities.map((entity) => entity.description ?? null);
  const rows = await tx.$queryRaw<{ id: string; name: string; entityType: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", description, metadata, "isManual", origin, "updatedAt")
    SELECT gen_random_uuid()::text, ${projectId}, x.name, x.type, x.type, x.description, '{}'::jsonb, true, 'manual', NOW()
    FROM unnest(${names}::text[], ${types}::text[], ${descriptions}::text[]) AS x(name, type, description)
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET
      description = COALESCE(EXCLUDED.description, entities.description), "updatedAt" = NOW()
    RETURNING id, name, "entityType"
  `;
  return new Map(rows.map((row) => [entityGraphKey({ name: row.name, entityType: row.entityType }), row.id]));
}

function batchEdges(relations: BatchGraphInput["relations"], ids: Map<string, string>) {
  const edges = new Map<string, ResolvedEdge & { sourceChunkId?: string }>();
  for (const relation of relations) {
    const origin = ids.get(entityGraphKey(relation.from));
    const target = ids.get(entityGraphKey(relation.to));
    if (!origin || !target) continue;
    const key = JSON.stringify([origin, target, relation.type]);
    if (!edges.has(key)) edges.set(key, { fromEntityId: origin, toEntityId: target, relationType: relation.type, sourceChunkId: relation.sourceChunkId });
  }
  return [...edges.values()];
}

async function upsertBatchRelations(tx: GraphWriter, projectId: string, edges: ReturnType<typeof batchEdges>) {
  if (edges.length === 0) return 0;
  const from = edges.map((edge) => edge.fromEntityId);
  const to = edges.map((edge) => edge.toEntityId);
  const types = edges.map((edge) => edge.relationType);
  const chunks = edges.map((edge) => edge.sourceChunkId ?? null);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO entity_relations (id, "projectId", "fromEntityId", "toEntityId", "relationType", "sourceChunkId", "isManual", origin)
    SELECT gen_random_uuid()::text, ${projectId}, x.a, x.b, x.rel, x.src, true, 'manual'
    FROM unnest(${from}::text[], ${to}::text[], ${types}::text[], ${chunks}::text[]) AS x(a, b, rel, src)
    ON CONFLICT ("fromEntityId", "toEntityId", "relationType") DO UPDATE SET
      "sourceChunkId" = COALESCE(entity_relations."sourceChunkId", EXCLUDED."sourceChunkId"),
      -- /v1/graph/batch is a manual write, so an edge that extraction created first must be promoted
      -- rather than left extracted with the manual request silently ignored.
      "isManual" = true,
      "origin" = 'manual'
    RETURNING id
  `;
  return rows.length;
}

/** One transaction for a whole graph push: two statements, no embedding model. */
export async function saveGraphBatch(projectId: string, input: BatchGraphInput) {
  const entities = batchEntities(input);
  return prisma.$transaction(async (tx) => {
    const ids = await upsertBatchEntities(tx, projectId, entities);
    const relations = await upsertBatchRelations(tx, projectId, batchEdges(input.relations, ids));
    await refreshEntityVectors(tx, [...ids.values()]);
    return { entities: ids.size, relations };
  });
}
