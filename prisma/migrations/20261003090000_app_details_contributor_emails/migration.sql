-- Several contributors per app: contactEmail (one) -> contributorEmails (JSON string[]).
ALTER TABLE "AppDetails" ADD COLUMN "contributorEmails" TEXT NOT NULL DEFAULT '[]';
UPDATE "AppDetails" SET "contributorEmails" = json_array("contactEmail") WHERE "contactEmail" IS NOT NULL AND "contactEmail" <> '';
ALTER TABLE "AppDetails" DROP COLUMN "contactEmail";
