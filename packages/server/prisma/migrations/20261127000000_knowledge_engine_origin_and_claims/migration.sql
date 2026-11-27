-- Knowledge engine, phase A: provenance on both graph tables, the evidence/claims store, and the
-- read-path indexes. Deploy-safe with old pods: no CHECK is added here, so a process that predates
-- this release keeps writing (isManual=false, origin DEFAULT 'manual') without a constraint error.
-- Apply phase B (knowledge_engine_origin_check) only after every writer passes origin.
BEGIN;

-- G-D: one explicit origin on entities AND relations. isManual stays because visibility SQL reads it.
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "entity_relations" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'manual';

-- Schema drift: present in the init migration, never modelled in schema.prisma.
CREATE INDEX IF NOT EXISTS "entity_relations_fromEntityId_idx" ON "entity_relations"("fromEntityId");
CREATE INDEX IF NOT EXISTS "entity_relations_toEntityId_idx" ON "entity_relations"("toEntityId");
CREATE INDEX IF NOT EXISTS "entity_relations_relationType_idx" ON "entity_relations"("relationType");

-- Read path: a claim's activation joins documents by (sourceId, contentHash).
CREATE INDEX IF NOT EXISTS "documents_sourceId_contentHash_idx" ON "documents"("sourceId", "contentHash");

-- One evidence row per (source, content text): the text is stored once, and the digest is what a
-- claim is anchored to instead of a source version or a chunk id.
CREATE TABLE IF NOT EXISTS "evidence" (
  "id"                 TEXT NOT NULL,
  "sourceId"           TEXT NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "contentDigest"      TEXT NOT NULL,
  "text"               TEXT NOT NULL,
  "documentExternalId" TEXT,
  "path"               TEXT,
  "url"                TEXT,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_sourceId_contentDigest_key" ON "evidence"("sourceId", "contentDigest");

CREATE TABLE IF NOT EXISTS "claims" (
  "id"         TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "entityId"   TEXT REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "relationId" TEXT REFERENCES "entity_relations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "confidence" DOUBLE PRECISION NOT NULL,
  "origin"     TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);

-- A claim has exactly one anchor kind; the two partial uniques make the pair unique per kind.
CREATE UNIQUE INDEX IF NOT EXISTS "claim_relation_uniq" ON "claims"("evidenceId", "relationId")
  WHERE "relationId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "claim_entity_uniq" ON "claims"("evidenceId", "entityId")
  WHERE "relationId" IS NULL AND "entityId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "claims_evidenceId_idx" ON "claims"("evidenceId");
CREATE INDEX IF NOT EXISTS "claims_entityId_idx" ON "claims"("entityId");
CREATE INDEX IF NOT EXISTS "claims_relationId_idx" ON "claims"("relationId");

COMMIT;
