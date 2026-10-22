-- Per-workspace record of the roles setup (schema.prisma WorkspaceRoleSetup,
-- src/lib/permissions.ts setUpWorkspaceRoles). No backfill: the facts it
-- needs (members, creator) live on proxy, so the API fills it in, one
-- workspace at a time, on its first request there and in a sweep at startup.

-- CreateTable
CREATE TABLE "WorkspaceRoleSetup" (
    "companyId" TEXT NOT NULL PRIMARY KEY,
    "ownerDecidedAt" DATETIME,
    "membersCapturedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
