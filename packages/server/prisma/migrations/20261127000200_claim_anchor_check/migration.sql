-- A claim is anchored to one kind of thing, never both: an entity claim and a relation claim share
-- the table, and a row carrying both anchors would satisfy neither partial unique below.
--
-- Both anchors NULL stays legal on purpose. `claims."entityId"`/`"relationId"` are ON DELETE SET
-- NULL, so deleting an entity or relation turns its claims into orphans; the maintenance job
-- (pruneClaims) deletes them. Forbidding both-NULL here would make that cascade fail instead.
BEGIN;

ALTER TABLE "claims" ADD CONSTRAINT "claims_anchor_check"
  CHECK ("entityId" IS NULL OR "relationId" IS NULL) NOT VALID;
ALTER TABLE "claims" VALIDATE CONSTRAINT "claims_anchor_check";

COMMIT;
