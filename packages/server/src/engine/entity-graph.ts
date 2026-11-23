import { prisma, Prisma } from "../db/index.js";
import { vectorLiteral } from "./entity-graph-write.js";
import { projectScopeSql as graphProject, type ProjectSearchScope as GraphScope, visibleSourceSql } from "./oracle-visibility.js";
import { compatibleEmbeddingModel } from "./vector-order.js";

interface ChunkScope {
  sourceIds?: string[];
  chunkTypes?: string[];
  metadataFilter?: Record<string, unknown>;
}

interface GraphSearch {
  scope: GraphScope;
  query?: string;
  embedding: readonly number[];
  embeddingModel: string | null;
  depth: number;
  topK: number;
  entityTypes?: string[];
  chunkScope?: ChunkScope;
}

export interface GraphRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: string;
  weight: number;
}

interface GraphEntity {
  id: string;
  name: string;
  entityType: string | null;
  description: string | null;
  metadata: Prisma.JsonValue;
}

type GraphReader = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;
const MAX_RELATIONS_PER_HOP = 50;

function activeGraphChunks(project: GraphScope, scope: ChunkScope = {}) {
  const { sourceIds, chunkTypes, metadataFilter } = scope;
  return Prisma.sql`FROM chunks c
    JOIN documents d ON d.id = c."documentId"
    JOIN sources s ON s.id = d."sourceId"
    WHERE c."projectId" = s."projectId" AND ${graphProject(Prisma.sql`c."projectId"`, project)}
      AND (d."projectId" IS NULL OR d."projectId" = c."projectId")
      AND d."deletedAt" IS NULL AND s."deletedAt" IS NULL
      AND d.status IN ('READY', 'INDEXED')
      AND d."sourceVersionId" IS NOT DISTINCT FROM s."activeVersionId"
      AND COALESCE(c.metadata->>'content_kind', '') <> 'parent_context'
      ${sourceIds?.length ? Prisma.sql`AND s.id = ANY(${sourceIds}::text[])` : Prisma.empty}
      ${chunkTypes?.length ? Prisma.sql`AND c."chunkType" = ANY(${chunkTypes}::text[])` : Prisma.empty}
      ${metadataFilter ? Prisma.sql`AND c.metadata @> ${JSON.stringify(metadataFilter)}::jsonb` : Prisma.empty}`;
}

function visibleGraphChunks(project: GraphScope, scope?: ChunkScope) {
  const orgId = typeof project === "string" ? undefined : project.orgId;
  return Prisma.sql`${activeGraphChunks(project, scope)} ${visibleSourceSql([], orgId)}
    ${orgId === undefined ? Prisma.empty : Prisma.sql`AND s."orgId" = ${orgId}`}`;
}

function activeMention(chunkId: Prisma.Sql, chunks: Prisma.Sql) {
  return Prisma.sql`EXISTS (SELECT 1 ${chunks} AND c.id = ${chunkId})`;
}

function activeClaims(mentions: Prisma.Sql, id: Prisma.Sql, chunks: Prisma.Sql) {
  return Prisma.sql`${mentions} = ${id} AND ${activeMention(Prisma.sql`m."chunkId"`, chunks)}`;
}

function ownedGraphChunks(chunks: Prisma.Sql, alias: Prisma.Sql) {
  return Prisma.sql`${chunks} AND c."projectId" = ${alias}."projectId"`;
}

function visibleGraphRecord(alias: Prisma.Sql, mentions: Prisma.Sql, chunks: Prisma.Sql) {
  return Prisma.sql`(${alias}."isManual" OR EXISTS (SELECT 1 ${activeClaims(mentions, Prisma.sql`${alias}.id`, ownedGraphChunks(chunks, alias))}))`;
}

const entityMentions = Prisma.sql`FROM entity_mentions m WHERE m."entityId"`;
const relationMentions = Prisma.sql`FROM entity_relation_mentions m WHERE m."relationId"`;

function projectEntities(project: GraphScope, chunks: Prisma.Sql) {
  return Prisma.sql`FROM entities e WHERE ${graphProject(Prisma.sql`e."projectId"`, project)} AND ${visibleGraphRecord(Prisma.sql`e`, entityMentions, chunks)}`;
}

function projectRelations(project: GraphScope, chunks: Prisma.Sql) {
  return Prisma.sql`FROM entity_relations r
    JOIN entities origin ON origin.id = r."fromEntityId" AND ${graphProject(Prisma.sql`origin."projectId"`, project)}
    JOIN entities target ON target.id = r."toEntityId" AND ${graphProject(Prisma.sql`target."projectId"`, project)}
    WHERE ${graphProject(Prisma.sql`r."projectId"`, project)}
      AND ${visibleGraphRecord(Prisma.sql`origin`, entityMentions, chunks)}
      AND ${visibleGraphRecord(Prisma.sql`target`, entityMentions, chunks)}
      AND ${visibleGraphRecord(Prisma.sql`r`, relationMentions, chunks)}`;
}

const relationColumns = Prisma.sql`r.id, r."fromEntityId", r."toEntityId", r."relationType", COALESCE(r.weight, 1) AS weight`;

async function findGraphSeeds(db: GraphReader, options: GraphSearch, chunks: Prisma.Sql) {
  const { scope, query, embedding, embeddingModel, topK, entityTypes } = options;
  const vector = vectorLiteral(embedding);
  const types = entityTypes?.length ? Prisma.sql`AND e."entityType" = ANY(${entityTypes}::text[])` : Prisma.empty;
  // Structural nodes carry no mention vector, so a name hit is a first-class seed.
  const nameSeeds = query
    ? Prisma.sql`, name_seeds AS (
      SELECT e.id, 0::float8 AS distance ${projectEntities(scope, chunks)}
      AND e.name ILIKE ${`%${query}%`} ${types}
      ORDER BY length(e.name), e.id LIMIT ${topK}
    )`
    : Prisma.empty;
  const nameUnion = query ? Prisma.sql` UNION ALL SELECT * FROM name_seeds` : Prisma.empty;
  // The manual seeds are ranked over their own distances, materialised first: an HNSW scan answers
  // from the tuples it visited in distance order, so a filtered, ordered query can return nothing
  // for entities that exist. See engine/vector-order.ts.
  return db.$queryRaw<{ id: string; similarity: number }[]>`
    WITH manual_distances AS MATERIALIZED (
      SELECT e.id, (e.embedding <=> ${vector}::vector) AS distance
      FROM entities e WHERE ${graphProject(Prisma.sql`e."projectId"`, scope)} AND e."isManual" AND e.embedding IS NOT NULL ${types}
        AND ${compatibleEmbeddingModel(Prisma.sql`e.metadata`, embeddingModel)}
        AND NOT EXISTS (SELECT 1 FROM entity_mentions m WHERE m."entityId" = e.id)
    ), manual_seeds AS (
      SELECT id, distance FROM manual_distances ORDER BY distance, id LIMIT ${topK}
    ), extracted_seeds AS (
      SELECT e.id, MIN(COALESCE(active.embedding, m.embedding) <=> ${vector}::vector) AS distance
      FROM entities e JOIN entity_mentions m ON m."entityId" = e.id
      JOIN LATERAL (SELECT c.embedding ${ownedGraphChunks(chunks, Prisma.sql`e`)} AND c.id = m."chunkId"
        AND ${compatibleEmbeddingModel(Prisma.sql`c.metadata`, embeddingModel)}) active ON true
      WHERE ${graphProject(Prisma.sql`e."projectId"`, scope)} AND COALESCE(active.embedding, m.embedding) IS NOT NULL ${types}
      GROUP BY e.id ORDER BY distance, e.id LIMIT ${topK}
    )${nameSeeds}
    SELECT id, 1 - MIN(distance) AS similarity
    FROM (SELECT * FROM manual_seeds UNION ALL SELECT * FROM extracted_seeds${nameUnion}) ranked
    GROUP BY id ORDER BY similarity DESC, id LIMIT ${topK}
  `;
}

function findGraphRelations(db: GraphReader, scope: Prisma.Sql, frontier: string[], seen: string[]) {
  return db.$queryRaw<GraphRelation[]>`
    SELECT ${relationColumns} ${scope} AND r.id <> ALL(${seen}::text[])
      AND (r."fromEntityId" = ANY(${frontier}::text[]) OR r."toEntityId" = ANY(${frontier}::text[]))
    ORDER BY weight DESC, r.id LIMIT ${MAX_RELATIONS_PER_HOP}
  `;
}

function nextFrontier(edges: GraphRelation[], visited: Set<string>) {
  const endpoints = new Set(edges.flatMap(({ fromEntityId, toEntityId }) => [fromEntityId, toEntityId]));
  return [...endpoints].filter((id) => !visited.has(id));
}

async function traverseGraph(db: GraphReader, options: GraphSearch, chunks: Prisma.Sql) {
  const seeds = new Map((await findGraphSeeds(db, options, chunks)).map(({ id, similarity }) => [id, similarity]));
  const visited = new Set(seeds.keys());
  const relations: GraphRelation[] = [];
  const scope = projectRelations(options.scope, chunks);
  let frontier = [...visited];
  for (let hop = 0; hop < options.depth && frontier.length; hop++) {
    const edges = await findGraphRelations(db, scope, frontier, relations.map(({ id }) => id));
    frontier = nextFrontier(edges, visited);
    for (const id of frontier) visited.add(id);
    relations.push(...edges);
  }
  return { ids: [...visited], seeds, relations };
}

type Traversal = Awaited<ReturnType<typeof traverseGraph>>;

function graphSnapshot<T>(read: (db: GraphReader) => Promise<T>) {
  return prisma.$transaction(read, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

function entityColumns(chunks: Prisma.Sql) {
  return Prisma.sql`e.id, e.name, e."entityType",
    COALESCE(CASE WHEN e."isManual" THEN e.description END, (
      SELECT m.description ${activeClaims(entityMentions, Prisma.sql`e.id`, ownedGraphChunks(chunks, Prisma.sql`e`))} AND m.description IS NOT NULL
      ORDER BY m."chunkId" LIMIT 1
    )) AS description,
    CASE WHEN e."isManual" THEN e.metadata ELSE '{}'::jsonb END AS metadata`;
}

async function readGraphEntities(db: GraphReader, scope: GraphScope, chunks: Prisma.Sql, ids: string[]) {
  if (!ids.length) return [];
  return db.$queryRaw<(GraphEntity & { project: string })[]>`
    SELECT ${entityColumns(chunks)}, (SELECT p.name FROM projects p WHERE p.id = e."projectId") AS project
    ${projectEntities(scope, chunks)} AND e.id = ANY(${ids}::text[])
    ORDER BY array_position(${ids}::text[], e.id)
  `;
}

export function searchEntityGraph(options: GraphSearch & { scope: { orgId: string; projectId?: string } }) {
  return graphSnapshot(async (db) => {
    const chunks = visibleKnowledgeChunks(options.scope.projectId, options.scope.orgId);
    const traversal = await traverseGraph(db, options, chunks);
    const nodes = await readGraphEntities(db, options.scope, chunks, traversal.ids);
    return { entities: nodes.map((node) => ({ ...node, similarity: traversal.seeds.get(node.id) ?? 0 })), relations: traversal.relations };
  });
}

export async function countGraphEntities(projectId: string) {
  const scope = projectEntities(projectId, activeGraphChunks(projectId));
  const [row] = await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count ${scope}`;
  return row.count;
}

function exportEntities(db: GraphReader, projectId: string, chunks: Prisma.Sql, limit: number) {
  if (!limit) return [];
  return db.$queryRaw<(GraphEntity & { createdAt: Date })[]>`
    SELECT ${entityColumns(chunks)}, e."createdAt" ${projectEntities(projectId, chunks)}
    ORDER BY e."createdAt", e.id LIMIT ${limit}
  `;
}

function exportRelations(db: GraphReader, projectId: string, chunks: Prisma.Sql, limit: number) {
  if (!limit) return [];
  return db.$queryRaw<(GraphRelation & { metadata: Prisma.JsonValue; createdAt: Date })[]>`
    SELECT ${relationColumns}, r.metadata, r."createdAt" ${projectRelations(projectId, chunks)}
    ORDER BY r."createdAt", r.id LIMIT ${limit}
  `;
}

export function exportProjectGraph(projectId: string, limits: { entities: number; relations: number }) {
  if (!limits.entities && !limits.relations) return Promise.resolve({ entities: [], relations: [] });
  const chunks = activeGraphChunks(projectId);
  return graphSnapshot(async (db) => ({
    entities: await exportEntities(db, projectId, chunks, limits.entities),
    relations: await exportRelations(db, projectId, chunks, limits.relations),
  }));
}

const DASHBOARD_GRAPH_SEEDS = 24;
export interface BrowserNode { id: string; label: string; type: string | null; project: string }

export function visibleKnowledgeChunks(projectId: string | undefined, orgId: string) {
  return visibleGraphChunks({ projectId, orgId });
}

export async function countVisibleGraphEntities(db: GraphReader, projectId: string | undefined, orgId: string) {
  const scope = projectEntities({ projectId, orgId }, visibleKnowledgeChunks(projectId, orgId));
  const [row] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count ${scope}`;
  return row.count;
}

function browseSeeds(db: GraphReader, scope: Prisma.Sql, query: string) {
  const name = query ? Prisma.sql`AND strpos(lower(e.name), lower(${query})) > 0` : Prisma.empty;
  return db.$queryRaw<{ id: string }[]>`
    SELECT e.id ${scope} ${name} ORDER BY e."createdAt" DESC, e.id LIMIT ${DASHBOARD_GRAPH_SEEDS}`;
}

function browseNodes(db: GraphReader, scope: Prisma.Sql, ids: string[]) {
  return db.$queryRaw<BrowserNode[]>`
    SELECT e.id, left(e.name, 240) AS label, e."entityType" AS type,
      (SELECT p.name FROM projects p WHERE p.id = e."projectId") AS project ${scope}
    AND e.id = ANY(${ids}::text[]) ORDER BY array_position(${ids}::text[], e.id)`;
}

export function browseProjectGraph(projectId: string | undefined, orgId: string, query: string) {
  return graphSnapshot(async (db) => {
    const chunks = visibleKnowledgeChunks(projectId, orgId);
    const project = { projectId, orgId };
    const scope = projectEntities(project, chunks);
    const seeds = new Set((await browseSeeds(db, scope, query)).map(({ id }) => id));
    if (seeds.size === 0) return { nodes: [], edges: [] };
    const edges = await findGraphRelations(db, projectRelations(project, chunks), [...seeds], []);
    const nodes = await browseNodes(db, scope, [...seeds, ...nextFrontier(edges, seeds)]);
    return { nodes, edges };
  });
}

interface GraphChunk {
  id: string;
  content: string;
  chunkType: string | null;
  metadata: Record<string, unknown>;
  seed: boolean;
  entities: { id: string; name: string; type: string | null }[];
}

function findGraphChunks(db: GraphReader, chunks: Prisma.Sql, traversal: Traversal, primaryIds: string[], limit: number) {
  const { ids, seeds } = traversal;
  return db.$queryRaw<GraphChunk[]>`
    WITH matched AS (
      SELECT m."chunkId", BOOL_OR(m."entityId" = ANY(${[...seeds.keys()]}::text[])) AS seed,
        MIN(array_position(${ids}::text[], m."entityId")) AS rank,
        JSONB_AGG(jsonb_build_object('id', e.id, 'name', e.name, 'type', e."entityType")
          ORDER BY array_position(${ids}::text[], e.id)) AS entities
      FROM entity_mentions m JOIN entities e ON e.id = m."entityId"
      WHERE m."entityId" = ANY(${ids}::text[]) AND ${activeMention(Prisma.sql`m."chunkId"`, ownedGraphChunks(chunks, Prisma.sql`e`))}
      GROUP BY m."chunkId"
    ), ordered AS (
      SELECT *, "chunkId" = ANY(${primaryIds}::text[]) AS primary_match,
        ROW_NUMBER() OVER (PARTITION BY seed, "chunkId" = ANY(${primaryIds}::text[]) ORDER BY rank, "chunkId") AS slot
      FROM matched
    )
    SELECT c.id, c.content, c."chunkType", c.metadata, o.seed, o.entities
    FROM ordered o JOIN chunks c ON c.id = o."chunkId"
    WHERE o.primary_match OR o.slot <= ${limit}
    ORDER BY o.seed DESC, o.slot, c.id
  `;
}

function graphEvidence(entities: GraphChunk["entities"], relations: GraphRelation[]) {
  const ids = new Set(entities.map(({ id }) => id));
  return {
    entities,
    relations: relations.filter((r) => ids.has(r.fromEntityId) || ids.has(r.toEntityId)).map((r) => ({
      id: r.id, from_entity_id: r.fromEntityId, to_entity_id: r.toEntityId, type: r.relationType, weight: r.weight,
    })),
  };
}

function prioritizeGraphChunks(chunks: GraphChunk[], primaryIds: string[], limit: number) {
  const primary = new Set(primaryIds);
  const novel = chunks.filter(({ id }) => !primary.has(id));
  const neighbor = novel.find(({ seed }) => !seed);
  if (!neighbor) return novel.slice(0, limit);
  return [neighbor, ...novel.filter(({ id }) => id !== neighbor.id)].slice(0, limit);
}

function toGraphResult(chunk: GraphChunk, seeds: Traversal["seeds"]) {
  const [entity] = chunk.entities;
  const similarity = seeds.get(entity.id);
  return {
    id: chunk.id, content: chunk.content, chunkType: chunk.chunkType || "text", source: "graph" as const,
    score: similarity === undefined ? 0.5 : similarity * 0.8,
    metadata: { ...chunk.metadata, entityName: entity.name, entityType: entity.type },
  };
}

export function searchGraphChunks(options: GraphSearch & { primaryChunkIds: string[] }) {
  return graphSnapshot(async (db) => {
    const scope = visibleGraphChunks(options.scope, options.chunkScope);
    const traversal = await traverseGraph(db, options, scope);
    const chunks = traversal.ids.length ? await findGraphChunks(db, scope, traversal, options.primaryChunkIds, options.topK) : [];
    const evidence = new Map(chunks.map(({ id, entities }) => [id, graphEvidence(entities, traversal.relations)]));
    const novel = prioritizeGraphChunks(chunks, options.primaryChunkIds, options.topK);
    const results = novel.map((chunk) => toGraphResult(chunk, traversal.seeds));
    return { results, evidence };
  });
}
