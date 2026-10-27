-- Team access: invite links, join requests, last active, invite resend
-- (docs/CLAUDE.md "Authorization", src/services/inviteLinks.ts).
-- Only new tables and new nullable columns: nothing existing changes, so
-- this is safe to deploy ahead of the code that reads it.

-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN "lastSeenAt" DATETIME;

-- AlterTable
ALTER TABLE "PendingInvite" ADD COLUMN "lastSentAt" DATETIME;

-- CreateTable
CREATE TABLE "InviteLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rule" TEXT NOT NULL DEFAULT 'anyone',
    "domains" TEXT NOT NULL DEFAULT '[]',
    "role" TEXT NOT NULL DEFAULT 'member',
    "appAccess" TEXT NOT NULL DEFAULT 'use',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" DATETIME
);

-- CreateTable
CREATE TABLE "JoinRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "linkId" TEXT,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteLink_code_key" ON "InviteLink"("code");

-- CreateIndex
CREATE INDEX "InviteLink_companyId_disabledAt_idx" ON "InviteLink"("companyId", "disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "JoinRequest_companyId_userId_key" ON "JoinRequest"("companyId", "userId");

-- CreateIndex
CREATE INDEX "JoinRequest_companyId_status_idx" ON "JoinRequest"("companyId", "status");
