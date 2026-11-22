-- Provenance for graph edges: which chunk asserted this relation.
ALTER TABLE entity_relations ADD COLUMN IF NOT EXISTS "sourceChunkId" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entity_relations_sourceChunkId_fkey'
  ) THEN
    ALTER TABLE entity_relations
      ADD CONSTRAINT "entity_relations_sourceChunkId_fkey"
      FOREIGN KEY ("sourceChunkId") REFERENCES chunks(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "entity_relations_sourceChunkId_idx" ON entity_relations ("sourceChunkId");
