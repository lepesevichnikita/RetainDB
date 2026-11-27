BEGIN;

-- A writer deployed before the knowledge engine omits origin and relies on its default 'manual',
-- while setting isManual = false. The strict CHECK would reject that write and take the old pods
-- down during a rolling deploy. Downgrade exactly that legacy conflict; keep rejecting the
-- opposite one, because a caller that claims 'import' and isManual = true is lying to the model.
CREATE OR REPLACE FUNCTION "retaindb_origin_legacy_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."origin" = 'manual' AND NEW."isManual" = false THEN
    NEW."origin" := 'extracted';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "entities_origin_legacy_guard" BEFORE INSERT OR UPDATE ON "entities"
  FOR EACH ROW EXECUTE FUNCTION "retaindb_origin_legacy_guard"();

CREATE TRIGGER "entity_relations_origin_legacy_guard" BEFORE INSERT OR UPDATE ON "entity_relations"
  FOR EACH ROW EXECUTE FUNCTION "retaindb_origin_legacy_guard"();

COMMIT;
