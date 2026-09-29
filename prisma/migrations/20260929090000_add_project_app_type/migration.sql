-- AlterTable
-- What the app is for, as told by whoever deployed it (see schema.prisma's
-- Project.appType). Nullable with no backfill: nothing records this for
-- existing projects, and it fills in on the next deploy that sends one.
ALTER TABLE "Project" ADD COLUMN "appType" TEXT;
