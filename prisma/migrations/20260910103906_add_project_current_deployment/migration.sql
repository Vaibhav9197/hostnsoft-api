-- AlterTable
ALTER TABLE "Project" ADD COLUMN "currentDeploymentId" TEXT;

-- Backfill: every project that already has a successful deployment gets
-- its most recent one as currentDeploymentId, computed the same way
-- customDomainActivation.ts's pushCustomDomainConfig used to derive
-- "the currently live deployment" via query before this column existed.
-- Without this, every project deployed before this migration would look
-- like it had never successfully deployed until its next deploy/rollback
-- (currentDeploymentId NULL), which pushCustomDomainConfig now treats as
-- "nothing to push a custom-domain config against yet".
UPDATE "Project"
SET "currentDeploymentId" = (
  SELECT "d"."id" FROM "Deployment" "d"
  WHERE "d"."projectId" = "Project"."id" AND "d"."status" = 'success'
  ORDER BY "d"."createdAt" DESC
  LIMIT 1
);
