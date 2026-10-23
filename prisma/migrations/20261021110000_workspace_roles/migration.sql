-- Workspace roles (docs/CLAUDE.md "Authorization", src/lib/permissions.ts).
--
-- Deliberately no backfill here. Who owns a workspace is a proxy fact (the
-- company's creator) that SQL can't read, and membership — who is still in
-- it — is too. So rows are written lazily instead: a member with no row is
-- an Admin (what everyone effectively was before this migration), and the
-- first time a workspace's roles are worked out, its Owner is picked then
-- (src/services/workspaceRoles.ts ensureOwner). Until then nothing about
-- access changes for anyone, which is also why this migration is safe to
-- deploy ahead of the code that reads it.

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "appAccess" TEXT NOT NULL DEFAULT 'use',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PendingInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "appAccess" TEXT NOT NULL DEFAULT 'use',
    "grants" TEXT NOT NULL DEFAULT '[]',
    "invitedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "WorkspaceMember_companyId_role_idx" ON "WorkspaceMember"("companyId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_companyId_userId_key" ON "WorkspaceMember"("companyId", "userId");

-- CreateIndex
CREATE INDEX "AppGrant_userId_idx" ON "AppGrant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AppGrant_projectId_userId_key" ON "AppGrant"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingInvite_companyId_email_key" ON "PendingInvite"("companyId", "email");

