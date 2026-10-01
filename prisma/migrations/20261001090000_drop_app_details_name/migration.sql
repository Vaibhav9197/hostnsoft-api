-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppDetails" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "description" TEXT,
    "story" TEXT,
    "appUrl" TEXT NOT NULL,
    "screenshotUrls" TEXT NOT NULL DEFAULT '[]',
    "videoUrl" TEXT,
    "creatorName" TEXT NOT NULL,
    "creatorProfile" TEXT,
    "contactEmail" TEXT,
    "builtWith" TEXT,
    "category" TEXT,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "customHtml" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppDetails_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AppDetails" ("appUrl", "builtWith", "category", "companyId", "contactEmail", "createdAt", "createdBy", "creatorName", "creatorProfile", "customHtml", "description", "featured", "id", "isPublic", "projectId", "screenshotUrls", "story", "tagline", "tagsJson", "updatedAt", "videoUrl") SELECT "appUrl", "builtWith", "category", "companyId", "contactEmail", "createdAt", "createdBy", "creatorName", "creatorProfile", "customHtml", "description", "featured", "id", "isPublic", "projectId", "screenshotUrls", "story", "tagline", "tagsJson", "updatedAt", "videoUrl" FROM "AppDetails";
DROP TABLE "AppDetails";
ALTER TABLE "new_AppDetails" RENAME TO "AppDetails";
CREATE UNIQUE INDEX "AppDetails_projectId_key" ON "AppDetails"("projectId");
CREATE INDEX "AppDetails_companyId_idx" ON "AppDetails"("companyId");
CREATE INDEX "AppDetails_isPublic_featured_createdAt_idx" ON "AppDetails"("isPublic", "featured", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

