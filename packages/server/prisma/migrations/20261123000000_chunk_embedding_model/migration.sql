-- Records which model produced a chunk vector, so a corpus can be checked for one model
-- and re-embedded without guessing. Existing rows stay NULL and read as "unknown model".
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT;
CREATE INDEX IF NOT EXISTS "chunks_embedding_model_idx" ON "chunks" ("embeddingModel");
