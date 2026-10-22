import { prisma } from "../lib/prisma";
import { hashToken } from "../lib/deployTokens";
import type { DeployToken } from "@prisma/client";
import { buildInvalidTokenGuidance, buildTokenSteps } from "../lib/orphanMessage";

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

// Who a deploy token acts as, in the one shape every token-authenticated
// path shares (req.actor on the agent routes, DeployActor.token on a
// deploy). Other branches build on this exact shape — keep it stable.
//   kind "workspace": acts as companyId; userId is only who minted it, for
//     attribution, never for access.
//   kind "user": acts as userId, wherever that person can reach; companyId
//     is the token's default workspace — where a new app is created.
export interface TokenActor {
  kind: "user" | "workspace";
  userId: string;
  companyId: string;
  tokenId: string;
}

export function tokenActorOf(record: DeployToken): TokenActor {
  return {
    // Anything but an explicit "user" is the old, narrower behaviour, so an
    // unexpected value can only ever reach less, never more.
    kind: record.kind === "user" ? "user" : "workspace",
    userId: record.createdBy,
    companyId: record.companyId,
    tokenId: record.id,
  };
}

// The 401 body every internal endpoint returns for a present-but-invalid
// deploy token. `guidance` tells an agent how to obtain a working one —
// hostnsoft-deploy relays it in its own 401 (follow-up in that repo).
export function unauthorizedDeployTokenBody() {
  return { error: "Unauthorized", guidance: buildInvalidTokenGuidance(), howToGetToken: buildTokenSteps() };
}
