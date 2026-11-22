-- One metadata field carries the model name, so a new model never adds a column.
UPDATE "chunks"
   SET metadata = jsonb_set(metadata, '{embedding_model}', to_jsonb("embeddingModel"), true)
 WHERE "embeddingModel" IS NOT NULL
   AND metadata IS NOT NULL;
ALTER TABLE "chunks" DROP COLUMN IF EXISTS "embeddingModel";
