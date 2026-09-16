-- CreateTable
CREATE TABLE "ShowcaseCollection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT,
    "type" TEXT NOT NULL DEFAULT 'public',
    "companyId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShowcaseProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collectionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "whatItDoes" TEXT,
    "whyBuilt" TEXT,
    "appUrl" TEXT NOT NULL,
    "screenshotUrl" TEXT,
    "videoUrl" TEXT,
    "creatorName" TEXT NOT NULL,
    "creatorProfile" TEXT,
    "builtWith" TEXT,
    "category" TEXT,
    "tagsJson" TEXT NOT NULL DEFAULT '[]',
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShowcaseProject_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ShowcaseCollection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseCollection_slug_key" ON "ShowcaseCollection"("slug");

-- CreateIndex
CREATE INDEX "ShowcaseCollection_companyId_idx" ON "ShowcaseCollection"("companyId");

-- CreateIndex
CREATE INDEX "ShowcaseCollection_type_idx" ON "ShowcaseCollection"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseProject_slug_key" ON "ShowcaseProject"("slug");

-- CreateIndex
CREATE INDEX "ShowcaseProject_companyId_idx" ON "ShowcaseProject"("companyId");

-- CreateIndex
CREATE INDEX "ShowcaseProject_collectionId_isPrivate_idx" ON "ShowcaseProject"("collectionId", "isPrivate");

-- CreateIndex
CREATE UNIQUE INDEX "ShowcaseProject_collectionId_projectId_key" ON "ShowcaseProject"("collectionId", "projectId");

