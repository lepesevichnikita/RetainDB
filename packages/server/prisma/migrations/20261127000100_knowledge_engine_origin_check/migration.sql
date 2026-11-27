-- Knowledge engine, phase B: give legacy machine-written rows their real origin, then tie isManual to
-- origin with a CHECK. Apply only AFTER every writer passes origin (phase A's release): NOT VALID
-- skips existing rows, but new rows are checked immediately, so an old pod that still writes
-- isManual=false with the default origin would start failing here.
BEGIN;

-- Rows stamped 'manual' by the column default that the old writers produced for machine output.
-- Batch-imported rows are indistinguishable from manual ones and stay 'manual' (documented limit).
UPDATE "entities" SET "origin" = 'extracted' WHERE "origin" = 'manual' AND "isManual" = false;
UPDATE "entity_relations" SET "origin" = 'extracted' WHERE "origin" = 'manual' AND "isManual" = false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entities_origin_manual_check') THEN
    ALTER TABLE "entities" ADD CONSTRAINT "entities_origin_manual_check"
      CHECK (("origin" = 'manual') = "isManual") NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_relations_origin_manual_check') THEN
    ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_origin_manual_check"
      CHECK (("origin" = 'manual') = "isManual") NOT VALID;
  END IF;
END $$;

ALTER TABLE "entities" VALIDATE CONSTRAINT "entities_origin_manual_check";
ALTER TABLE "entity_relations" VALIDATE CONSTRAINT "entity_relations_origin_manual_check";

COMMIT;
