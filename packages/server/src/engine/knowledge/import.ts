import { prisma, type Transaction } from "../../db/index.js";
import { ingestDocument } from "../ingest.js";
import { saveChunkGraph, type ChunkGraph } from "../entity-graph-write.js";
import { createStagedSourceVersion, failSourceVersion, promoteSourceVersion } from "../source-versions.js";
import { claimInputsFromGraph, evidenceDigest, saveClaims } from "./claims.js";

/**
 * Imported knowledge is asserted by the source itself, so it starts above the extraction prior.
 * A document or an entity may override it with an explicit confidence.
 */
export const IMPORT_CONFIDENCE_PRIOR = 0.8;

export interface ImportDocumentInput {
  externalId: string;
  title: string;
  content: string;
  path?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown>;
  graph?: ChunkGraph;
}

export interface ImportSourceVersionInput {
  sourceId: string;
  projectId: string;
  documents: ImportDocumentInput[];
  confidence?: number;
}

/**
 * One staged version per import: documents, their graph and their claims commit together, and the
 * version becomes active only after every document landed. A failure leaves no partial version.
 */
export async function importSourceVersion(input: ImportSourceVersionInput) {
  const version = await createStagedSourceVersion(input.sourceId);
  try {
    const claims = await prisma.$transaction(async (tx) => {
      let total = 0;
      for (const document of input.documents) total += await importDocument(tx, input, version.id, document);
      return total;
    });
    await promoteSourceVersion({ sourceId: input.sourceId, sourceVersionId: version.id });
    return { sourceVersionId: version.id, documents: input.documents.length, claims };
  } catch (error) {
    await failSourceVersion({
      sourceId: input.sourceId, sourceVersionId: version.id,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function importDocument(tx: Transaction, input: ImportSourceVersionInput, versionId: string, document: ImportDocumentInput): Promise<number> {
  if (!document.content.trim()) throw new Error(`Import document ${document.externalId} has no content.`);
  const ingested = await ingestDocument({
    sourceId: input.sourceId, projectId: input.projectId, externalId: document.externalId,
    title: document.title, content: document.content, metadata: document.metadata,
    filePath: document.path ?? undefined, url: document.url ?? undefined,
    sourceVersionId: versionId, skipEntityExtraction: true, skipSourceCountUpdate: true,
  }, tx);
  if (!document.graph) return 0;
  const chunks = await tx.chunk.findMany({ where: { documentId: ingested.documentId }, select: { id: true, content: true } });
  let claims = 0;
  for (const chunk of chunks) {
    const written = await saveChunkGraph(input.projectId, chunk.id, document.graph, "import", tx, "merge");
    const evidence = {
      sourceId: input.sourceId, contentDigest: evidenceDigest(chunk.content), text: chunk.content,
      documentExternalId: document.externalId, path: document.path ?? null, url: document.url ?? null,
    };
    claims += await saveClaims(tx, claimInputsFromGraph({
      graph: document.graph, written, evidence,
      prior: input.confidence ?? IMPORT_CONFIDENCE_PRIOR, origin: "import",
    }));
  }
  return claims;
}
