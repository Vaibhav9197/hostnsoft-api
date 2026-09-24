-- AlterTable
-- How the project is deployed: "service" | "static" (see schema.prisma's
-- Project.kind). No backfill beyond the default: hostnsoft-api has no
-- record of which existing projects are static — that lives in
-- hostnsoft-deploy's own static-site manifests — so every project starts
-- as "service" here and is corrected on its next successful deploy, when
-- hostnsoft-deploy reports its kind.
ALTER TABLE "Project" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'service';
