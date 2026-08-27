import { prisma } from "../lib/prisma";
import { hashToken } from "../lib/deployTokens";
import type { DeployToken } from "@prisma/client";

// Shared by every internal (server-to-server, hostnsoft-deploy-facing)
// endpoint that needs to confirm a company-scoped deploy token is real,
// live, and belongs to the claimed company — see
// src/routes/internalTokens.routes.ts and internalDeployments.routes.ts.
// Also bumps lastUsedAt on success, since this IS a real use of the token.
export async function findLiveDeployToken(
  companyId: string,
  token: string
): Promise<DeployToken | null> {
  const record = await prisma.deployToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  const isLive =
    !!record &&
    record.companyId === companyId &&
    (!record.revokedAt || record.revokedAt.getTime() > Date.now());

  if (!isLive) return null;

  return prisma.deployToken.update({
    where: { id: record!.id },
    data: { lastUsedAt: new Date() },
  });
}
