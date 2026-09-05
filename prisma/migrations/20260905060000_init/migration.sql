-- Squashed baseline. Drops every table this service has ever owned
-- (including pre-proxy identity tables) and recreates the current schema.
-- DESTRUCTIVE: all existing rows are lost.
-- Safe to run with `prisma migrate deploy` against a server that has old
-- migration history: deploy ignores history rows whose files are gone and
-- simply applies this one (verified against the pre-squash schema).
PRAGMA foreign_keys=OFF;

-- Drop everything, children before parents. SQLite drops a table's
-- indexes with it, so no separate DROP INDEX is needed.
DROP TABLE IF EXISTS "RefreshToken";
DROP TABLE IF EXISTS "CompanyMembership";
DROP TABLE IF EXISTS "Domain";
DROP TABLE IF EXISTS "EnvVar";
DROP TABLE IF EXISTS "Deployment";
DROP TABLE IF EXISTS "AuditLog";
DROP TABLE IF EXISTS "DeployToken";
DROP TABLE IF EXISTS "Project";
DROP TABLE IF EXISTS "User";
DROP TABLE IF EXISTS "Company";
-- Leftovers from SQLite "RedefineTables" migrations that may have aborted midway.
DROP TABLE IF EXISTS "new_Project";
DROP TABLE IF EXISTS "new_Deployment";

PRAGMA foreign_keys=ON;

-- CreateTable
CREATE TABLE "DeployToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT,
    "createdBy" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memoryMb" INTEGER NOT NULL DEFAULT 256,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "isOrphan" BOOLEAN NOT NULL DEFAULT false,
    "orphanExpiresAt" DATETIME
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_dns',
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Domain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "imageTag" TEXT,
    "memoryMb" INTEGER,
    "status" TEXT NOT NULL,
    "errorDetail" TEXT,
    "triggeredBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EnvVar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "EnvVar_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorUserId" TEXT,
    "companyId" TEXT,
    "projectId" TEXT,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DeployToken_tokenHash_key" ON "DeployToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DeployToken_companyId_idx" ON "DeployToken"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Project_companyId_idx" ON "Project"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_domain_key" ON "Domain"("domain");

-- CreateIndex
CREATE INDEX "Domain_projectId_idx" ON "Domain"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_projectId_version_key" ON "Deployment"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "EnvVar_projectId_key_key" ON "EnvVar"("projectId", "key");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

