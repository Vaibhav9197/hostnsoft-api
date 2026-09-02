import { prisma } from "../lib/prisma";
import { hashToken } from "../lib/deployTokens";
import type { DeployToken } from "@prisma/client";

// Shared by every internal (server-to-server, hostnsoft-deploy-facing)
// endpoint that needs to confirm a deploy token is real and live — see
// src/routes/internalTokens.routes.ts, internalProjects.routes.ts, and
// internalDeployments.routes.ts. The token IS the company identity: it's
// already company-scoped at creation (see tokens.routes.ts), so which
// company a deploy belongs to is read off the token's own row
// (`companyId`) rather than asked of the caller — hostnsoft-deploy has no
// separate company concept to get right or wrong. Also bumps lastUsedAt
// on success, since this IS a real use of the token.
export async function findLiveDeployToken(token: string): Promise<DeployToken | null> {
  const record = await prisma.deployToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  const isLive = !!record && (!record.revokedAt || record.revokedAt.getTime() > Date.now());
  if (!isLive) return null;

  return prisma.deployToken.update({
    where: { id: record!.id },
    data: { lastUsedAt: new Date() },
  });
}
