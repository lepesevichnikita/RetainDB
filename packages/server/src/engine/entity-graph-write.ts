import { z } from "zod";
import { prisma, Prisma } from "../db/index.js";

type GraphWriter = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export const entityRelationType = z.enum([
  "imports", "exports", "calls", "implements", "extends", "references",
  "depends_on", "related_to", "part_of", "contradicts", "supersedes",
]);

type RelationType = z.infer<typeof entityRelationType>;

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
  entities: (EntityKey & { description?: string })[];
  relations: { from: EntityKey; to: EntityKey; type: RelationType }[];
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
    INSERT INTO entities (id, "projectId", name, type, "entityType", description, metadata, embedding, "updatedAt")
    VALUES (gen_random_uuid()::text, ${projectId}, ${name}, ${entityType}, ${entityType}, ${description ?? null},
      COALESCE(${json}::jsonb, '{}'::jsonb), NULL, NOW())
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET
      description = COALESCE(EXCLUDED.description, CASE WHEN entities."isManual" THEN entities.description END),
      metadata = COALESCE(${json}::jsonb, entities.metadata),
      "isManual" = true, "updatedAt" = NOW()
    RETURNING id
  `;
  return row.id;
}

export async function ensureGraphEntityId(identity: EntityIdentity) {
  const existing = await prisma.entity.findUnique({
    where: { projectId_name_entityType: identity }, select: { id: true, isManual: true },
  });
  if (existing?.isManual) return existing.id;
  return writeManualEntity(identity);
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
  return prisma.entityRelation.upsert({
    where: { fromEntityId_toEntityId_relationType: { fromEntityId, toEntityId, relationType } },
    update: { projectId: input.projectId, weight, metadata, isManual: true, sourceChunkId },
    create: input,
    select: { id: true, projectId: true, fromEntityId: true, toEntityId: true,
      relationType: true, weight: true, metadata: true, sourceChunkId: true, createdAt: true },
  });
}

function entityKey({ name, entityType }: EntityKey) {
  return JSON.stringify([entityType, name]);
}

function uniqueClaims(graph: ChunkGraph) {
  const entries = new Map(graph.entities.map((entity) => [entityKey(entity), entity]));
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

async function putEntityMention(tx: GraphWriter, projectId: string, chunkId: string, entity: ChunkGraph["entities"][number]) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", "updatedAt")
    VALUES (gen_random_uuid()::text, ${projectId}, ${entity.name}, ${entity.entityType}, ${entity.entityType}, false, NOW())
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET name = EXCLUDED.name
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
    const origin = ids.get(entityKey(from));
    const target = ids.get(entityKey(to));
    if (origin && target) edges.set(JSON.stringify([origin, target, type]), { fromEntityId: origin, toEntityId: target, relationType: type });
  }
  return [...edges.keys()].sort().flatMap((key) => edges.get(key) ?? []);
}

async function putRelationMention(tx: GraphWriter, projectId: string, chunkId: string, edge: ResolvedEdge) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO entity_relations (id, "projectId", "fromEntityId", "toEntityId", "relationType", "sourceChunkId", "isManual")
    VALUES (gen_random_uuid()::text, ${projectId}, ${edge.fromEntityId}, ${edge.toEntityId}, ${edge.relationType}, ${chunkId}, false)
    ON CONFLICT ("fromEntityId", "toEntityId", "relationType") DO UPDATE SET
      "relationType" = EXCLUDED."relationType",
      "sourceChunkId" = COALESCE(entity_relations."sourceChunkId", EXCLUDED."sourceChunkId")
    RETURNING id
  `;
  await tx.$executeRaw`
    INSERT INTO entity_relation_mentions ("relationId", "chunkId") VALUES (${row.id}, ${chunkId}) ON CONFLICT DO NOTHING
  `;
  return row.id;
}

type ChunkGraphWriteMode = "replace" | "merge";

async function writeChunkClaims(tx: GraphWriter, projectId: string, chunkId: string, graph: ChunkGraph, mode: ChunkGraphWriteMode) {
  const entityIds = new Map<string, string>();
  for (const entity of uniqueClaims(graph)) {
    entityIds.set(entityKey(entity), await putEntityMention(tx, projectId, chunkId, entity));
  }
  const relationIds: string[] = [];
  for (const edge of resolveEdges(graph.relations, entityIds)) {
    relationIds.push(await putRelationMention(tx, projectId, chunkId, edge));
  }
  if (mode === "replace") await pruneOmittedMentions(tx, chunkId, relationIds, [...entityIds.values()]);
  await refreshEntityVectors(tx, [...entityIds.values()]);
  return { entities: entityIds.size, relations: relationIds.length };
}

async function pruneOmittedMentions(tx: GraphWriter, chunkId: string, relationIds: string[], entityIds: string[]) {
  await tx.$executeRaw`DELETE FROM entity_relation_mentions WHERE "chunkId" = ${chunkId} AND NOT ("relationId" = ANY(${relationIds}::text[]))`;
  await tx.$executeRaw`DELETE FROM entity_mentions WHERE "chunkId" = ${chunkId} AND NOT ("entityId" = ANY(${entityIds}::text[]))`;
}

export async function saveChunkGraph(projectId: string, chunkId: string, graph: ChunkGraph, transaction?: GraphWriter, mode: ChunkGraphWriteMode = "replace") {
  const save = async (tx: GraphWriter) => {
    if (!await claimChunk(tx, projectId, chunkId)) return { entities: 0, relations: 0 };
    return writeChunkClaims(tx, projectId, chunkId, graph, mode);
  };
  return transaction ? save(transaction) : prisma.$transaction(save);
}

export interface BatchGraphInput {
  entities: (EntityKey & { description?: string })[];
  relations: { from: EntityKey; to: EntityKey; type: RelationType; sourceChunkId?: string }[];
}

function batchEntities(input: BatchGraphInput) {
  const unique = new Map<string, EntityKey & { description?: string }>();
  for (const entity of input.entities) unique.set(entityKey(entity), entity);
  for (const relation of input.relations) {
    unique.set(entityKey(relation.from), relation.from);
    unique.set(entityKey(relation.to), relation.to);
  }
  return [...unique.values()];
}

async function upsertBatchEntities(tx: GraphWriter, projectId: string, entities: ReturnType<typeof batchEntities>) {
  if (entities.length === 0) return new Map<string, string>();
  const names = entities.map((entity) => entity.name);
  const types = entities.map((entity) => entity.entityType);
  const descriptions = entities.map((entity) => entity.description ?? null);
  const rows = await tx.$queryRaw<{ id: string; name: string; entityType: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", description, metadata, "isManual", "updatedAt")
    SELECT gen_random_uuid()::text, ${projectId}, x.name, x.type, x.type, x.description, '{}'::jsonb, true, NOW()
    FROM unnest(${names}::text[], ${types}::text[], ${descriptions}::text[]) AS x(name, type, description)
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET
      description = COALESCE(EXCLUDED.description, entities.description), "updatedAt" = NOW()
    RETURNING id, name, "entityType"
  `;
  return new Map(rows.map((row) => [entityKey({ name: row.name, entityType: row.entityType }), row.id]));
}

function batchEdges(relations: BatchGraphInput["relations"], ids: Map<string, string>) {
  const edges = new Map<string, ResolvedEdge & { sourceChunkId?: string }>();
  for (const relation of relations) {
    const origin = ids.get(entityKey(relation.from));
    const target = ids.get(entityKey(relation.to));
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
    INSERT INTO entity_relations (id, "projectId", "fromEntityId", "toEntityId", "relationType", "sourceChunkId", "isManual")
    SELECT gen_random_uuid()::text, ${projectId}, x.a, x.b, x.rel, x.src, true
    FROM unnest(${from}::text[], ${to}::text[], ${types}::text[], ${chunks}::text[]) AS x(a, b, rel, src)
    ON CONFLICT ("fromEntityId", "toEntityId", "relationType") DO UPDATE SET
      "sourceChunkId" = COALESCE(entity_relations."sourceChunkId", EXCLUDED."sourceChunkId"), "isManual" = true
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
