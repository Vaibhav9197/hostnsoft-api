-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE IF EXISTS "ShowcaseCollection";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE IF EXISTS "ShowcaseProject";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "AppDetails" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "name" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "ShowcaseEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT,
    "companyId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "submitCode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShowcaseEventListing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appDetailsId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShowcaseEventListing_appDetailsId_fkey" FOREIGN KEY ("appDetailsId") REFERENCES "AppDetails" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShowcaseEventListing_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ShowcaseEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AppDetails_projectId_key" ON "AppDetails"("projectId");

-- CreateIndex
CREATE INDEX "AppDetails_companyId_idx" ON "AppDetails"("companyId");

-- CreateIndex
CREATE INDEX "AppDetails_isPublic_featured_createdAt_idx" ON "AppDetails"("isPublic", "featured", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseEvent_slug_key" ON "ShowcaseEvent"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseEvent_submitCode_key" ON "ShowcaseEvent"("submitCode");

-- CreateIndex
CREATE INDEX "ShowcaseEvent_companyId_idx" ON "ShowcaseEvent"("companyId");

-- CreateIndex
CREATE INDEX "ShowcaseEventListing_eventId_status_isHidden_idx" ON "ShowcaseEventListing"("eventId", "status", "isHidden");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseEventListing_appDetailsId_eventId_key" ON "ShowcaseEventListing"("appDetailsId", "eventId");

