-- AlterTable
-- Deploy attribution (see schema.prisma's Deployment.source/agentName).
ALTER TABLE "Deployment" ADD COLUMN "source" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "agentName" TEXT;

-- Backfill source from triggeredBy's existing prefixes: dashboard uploads
-- ("dashboard:<userId>") and dashboard rollbacks ("rollback:<userId>",
-- "re-deploy:<userId>") were a person; everything else with a value was a
-- deploy token (its label, or "agent:<label>" / "config:agent:<label>").
-- agentName has no history to recover and stays null.
UPDATE "Deployment" SET "source" = CASE
  WHEN "triggeredBy" LIKE 'dashboard:%'
    OR "triggeredBy" LIKE 'rollback:%'
    OR "triggeredBy" LIKE 're-deploy:%' THEN 'dashboard'
  WHEN "triggeredBy" IS NOT NULL THEN 'agent'
  ELSE NULL
END;
