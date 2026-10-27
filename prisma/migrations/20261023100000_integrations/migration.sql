-- Integrations (see docs/integrations.md): a hidden viasocket workspace per
-- Embarko workspace, and an embed project per app that turns it on.
-- Additive only: two new tables, nothing existing is touched.

-- CreateTable
CREATE TABLE "IntegrationsWorkspace" (
    "companyId" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "authKey" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IntegrationsProject" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "embedProjectId" TEXT NOT NULL,
    "authKey" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" DATETIME,
    CONSTRAINT "IntegrationsProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Workspace-level Integrations switch. Off by default; only an Owner turns it on.
ALTER TABLE "Company" ADD COLUMN "integrationsEnabled" BOOLEAN NOT NULL DEFAULT false;
