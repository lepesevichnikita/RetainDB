BEGIN;

ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS "entity_mentions" (
  "entityId" TEXT NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "chunkId" TEXT NOT NULL REFERENCES "chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "description" TEXT,
  "embedding" vector(1024),
  PRIMARY KEY ("entityId", "chunkId")
);
CREATE INDEX IF NOT EXISTS "entity_mentions_chunkId_idx" ON "entity_mentions"("chunkId");

CREATE TABLE IF NOT EXISTS "entity_relation_mentions" (
  "relationId" TEXT NOT NULL REFERENCES "entity_relations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "chunkId" TEXT NOT NULL REFERENCES "chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("relationId", "chunkId")
);
CREATE INDEX IF NOT EXISTS "entity_relation_mentions_chunkId_idx" ON "entity_relation_mentions"("chunkId");

-- Backfill once, without reviving mentions later removed by re-extraction.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'entities'::regclass AND attname = 'isManual' AND NOT attisdropped) THEN
    ALTER TABLE "entities" ADD COLUMN "isManual" BOOLEAN NOT NULL DEFAULT true;
    UPDATE "entities" SET "isManual" = false WHERE "sourceChunkId" IS NOT NULL OR "documentId" IS NOT NULL;

    INSERT INTO "entity_mentions" ("entityId", "chunkId", "description", "embedding")
    SELECT e.id, c.id, e.description, e.embedding
    FROM entities e JOIN chunks c ON c.id = e."sourceChunkId" AND c."projectId" = e."projectId"
    ON CONFLICT DO NOTHING;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'entity_relations'::regclass AND attname = 'isManual' AND NOT attisdropped) THEN
    ALTER TABLE "entity_relations" ADD COLUMN "isManual" BOOLEAN NOT NULL DEFAULT true;
    -- Matching current endpoint chunks do not prove where a legacy edge came from.
    UPDATE "entity_relations" SET "isManual" = false WHERE metadata = '{"autoExtracted":true}'::jsonb;
  END IF;
END $$;

COMMIT;
