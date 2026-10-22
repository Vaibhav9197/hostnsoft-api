/**
 * Token minting for the public email endpoint (src/services/publicTokenRequest.ts).
 *
 * Deliberately NOT a rotation: every request adds one brand-new token and
 * leaves every existing token untouched, so a service still deploying with
 * an older token keeps working. Users revoke unwanted ones from the
 * dashboard like any other token.
 */
import type { DeployToken } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateDeployToken, type DeployTokenKind, type DeployTokenSource } from "../lib/deployTokens";
import { logAudit } from "./audit";

// `createdBy` when no logged-in actor exists.
export const SYSTEM_ACTOR = "system:public-token-api";

export const EMAIL_TOKEN_LABEL_PREFIX = "Agent Token: ";

// Tokens from this endpoint are requested by agents, not by a person in the UI.
const SOURCE: DeployTokenSource = "agent";

// A user token when there is a user to act as (always, since the endpoint
// started passing one): it is mailed to one person, for their agent. Each
// workspace's token still gets that workspace as its default — where its new
// apps go — so the mail's one-token-per-workspace shape is unchanged. A token
// with no user behind it has nobody to act as, so it stays a workspace token.
function kindFor(userId?: string): DeployTokenKind {
  return userId ? "user" : "workspace";
}

export async function mintEmailToken(
  companyId: string,
  actor: { userId?: string } = {}
): Promise<{ record: DeployToken; token: string }> {
  const { token, prefix, tokenHash } = generateDeployToken();
  const time = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
  const label = `${EMAIL_TOKEN_LABEL_PREFIX} ${time} IST`;
  const record = await prisma.deployToken.create({
    data: {
      companyId,
      createdBy: actor.userId ?? SYSTEM_ACTOR,
      label,
      tokenHash,
      tokenPrefix: prefix,
      source: SOURCE,
      kind: kindFor(actor.userId),
    },
  });
  await logAudit({ actorUserId: actor.userId, companyId, action: "token.create", details: label });
  return { record, token };
}
