-- CreateTable
CREATE TABLE "FeatureRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "email" TEXT,
    "userId" TEXT,
    "companyId" TEXT,
    "projectSlug" TEXT,
    "agentName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "FeatureRequest_companyId_createdAt_idx" ON "FeatureRequest"("companyId", "createdAt");
