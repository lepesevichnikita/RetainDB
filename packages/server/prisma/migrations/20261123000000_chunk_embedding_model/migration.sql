-- The model that produced a vector belongs to the chunk's metadata, not to a column of its own.
ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT;
DROP INDEX IF EXISTS "chunks_embedding_model_idx";
