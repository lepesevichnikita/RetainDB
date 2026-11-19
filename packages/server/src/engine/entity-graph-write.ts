import { z } from "zod";
import { prisma, Prisma } from "../db/index.js";
import { embed, embedSingle } from "./embeddings.js";

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
}

export interface ChunkGraph {
  entities: (EntityKey & { description?: string })[];
  relations: { from: EntityKey; to: EntityKey; type: RelationType }[];
}

export function vectorLiteral(vector: readonly number[]) {
  return `[${vector.join(",")}]`;
}

function entityText({ name, entityType, description }: EntityKey & { description?: string }) {
  return description ? `${entityType}: ${name} - ${description}` : `${entityType}: ${name}`;
}

function jsonMetadata(metadata: Prisma.InputJsonObject | undefined) {
  return metadata === undefined ? null : JSON.stringify(metadata);
}

export async function saveGraphEntity(input: EntityInput) {
  const embedding = vectorLiteral(await embedSingle(entityText(input)));
  const id = await writeManualEntity(input, embedding);
  return prisma.entity.findUniqueOrThrow({ where: { id }, select: {
    id: true, documentId: true, projectId: true, name: true, type: true, entityType: true,
    description: true, aliases: true, metadata: true, createdAt: true, updatedAt: true,
  } });
}

async function writeManualEntity(input: EntityInput, embedding: string) {
  const { projectId, name, entityType, description, metadata } = input;
  const json = jsonMetadata(metadata);
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", description, metadata, embedding, "updatedAt")
    VALUES (gen_random_uuid()::text, ${projectId}, ${name}, ${entityType}, ${entityType}, ${description ?? null},
      COALESCE(${json}::jsonb, '{}'::jsonb), ${embedding}::vector, NOW())
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET
      description = COALESCE(EXCLUDED.description, CASE WHEN entities."isManual" THEN entities.description END),
      metadata = COALESCE(${json}::jsonb, entities.metadata),
      embedding = CASE WHEN EXCLUDED.description IS NULL AND entities."isManual"
        THEN COALESCE(entities.embedding, EXCLUDED.embedding) ELSE EXCLUDED.embedding END,
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
  return writeManualEntity(identity, vectorLiteral(await embedSingle(entityText(identity))));
}

export function saveGraphRelation(input: RelationInput) {
  const { fromEntityId, toEntityId, relationType, weight, metadata } = input;
  return prisma.entityRelation.upsert({
    where: { fromEntityId_toEntityId_relationType: { fromEntityId, toEntityId, relationType } },
    update: { projectId: input.projectId, weight, metadata, isManual: true },
    create: input,
    select: { id: true, projectId: true, fromEntityId: true, toEntityId: true,
      relationType: true, weight: true, metadata: true, createdAt: true },
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

async function putEntityMention(tx: GraphWriter, projectId: string, chunkId: string, entity: ChunkGraph["entities"][number], embedding: number[]) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO entities (id, "projectId", name, type, "entityType", "isManual", "updatedAt")
    VALUES (gen_random_uuid()::text, ${projectId}, ${entity.name}, ${entity.entityType}, ${entity.entityType}, false, NOW())
    ON CONFLICT ("projectId", name, "entityType") DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  await tx.$executeRaw`
    INSERT INTO entity_mentions ("entityId", "chunkId", description, embedding)
    VALUES (${row.id}, ${chunkId}, ${entity.description ?? null}, ${vectorLiteral(embedding)}::vector)
    ON CONFLICT ("entityId", "chunkId") DO UPDATE
    SET description = EXCLUDED.description, embedding = EXCLUDED.embedding
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
    INSERT INTO entity_relations (id, "projectId", "fromEntityId", "toEntityId", "relationType", "isManual")
    VALUES (gen_random_uuid()::text, ${projectId}, ${edge.fromEntityId}, ${edge.toEntityId}, ${edge.relationType}, false)
    ON CONFLICT ("fromEntityId", "toEntityId", "relationType") DO UPDATE SET "relationType" = EXCLUDED."relationType"
    RETURNING id
  `;
  await tx.$executeRaw`
    INSERT INTO entity_relation_mentions ("relationId", "chunkId") VALUES (${row.id}, ${chunkId}) ON CONFLICT DO NOTHING
  `;
  return row.id;
}

async function writeChunkClaims(tx: GraphWriter, projectId: string, chunkId: string, entities: ChunkGraph["entities"], vectors: number[][], graph: ChunkGraph) {
  const entityIds = new Map<string, string>();
  for (const [index, entity] of entities.entries()) {
    entityIds.set(entityKey(entity), await putEntityMention(tx, projectId, chunkId, entity, vectors[index]));
  }
  const relationIds: string[] = [];
  for (const edge of resolveEdges(graph.relations, entityIds)) {
    relationIds.push(await putRelationMention(tx, projectId, chunkId, edge));
  }
  await tx.$executeRaw`DELETE FROM entity_relation_mentions WHERE "chunkId" = ${chunkId} AND NOT ("relationId" = ANY(${relationIds}::text[]))`;
  await tx.$executeRaw`DELETE FROM entity_mentions WHERE "chunkId" = ${chunkId} AND NOT ("entityId" = ANY(${[...entityIds.values()]}::text[]))`;
  return { entities: entityIds.size, relations: relationIds.length };
}

export async function saveChunkGraph(projectId: string, chunkId: string, graph: ChunkGraph) {
  const entities = uniqueClaims(graph);
  const vectors = entities.length ? await embed(entities.map(entityText)) : [];
  if (vectors.length !== entities.length) throw new Error("Graph entity embedding count mismatch");
  return prisma.$transaction(async (tx) => {
    if (!await claimChunk(tx, projectId, chunkId)) return { entities: 0, relations: 0 };
    return writeChunkClaims(tx, projectId, chunkId, entities, vectors, graph);
  });
}
