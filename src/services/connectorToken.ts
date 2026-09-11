/**
 * Token minting for the AI-connector exchange endpoint
 * (src/routes/connectorAuth.routes.ts).
 *
 * Same "always mint a new one, never touch existing tokens" shape as
 * src/services/emailToken.ts: an AI client connecting (or reconnecting)
 * gets its own token, and nothing already deployed with an older token
 * breaks. The person revokes unwanted ones from the dashboard like any
 * other token — they all show up in GET /companies/:companyId/tokens with
 * source "connector".
 */
import type { DeployToken } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateDeployToken, type DeployTokenSource } from "../lib/deployTokens";
import { logAudit } from "./audit";

export const CONNECTOR_TOKEN_LABEL_PREFIX = "Connector Token: ";

const SOURCE: DeployTokenSource = "connector";

export async function mintConnectorToken(
  companyId: string,
  actor: { userId: string }
): Promise<{ record: DeployToken; token: string }> {
  const { token, prefix, tokenHash } = generateDeployToken();
  const time = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
  const label = `${CONNECTOR_TOKEN_LABEL_PREFIX}${time} IST`;
  const record = await prisma.deployToken.create({
    data: {
      companyId,
      createdBy: actor.userId,
      label,
      tokenHash,
      tokenPrefix: prefix,
      source: SOURCE,
    },
  });
  await logAudit({ actorUserId: actor.userId, companyId, action: "token.create", details: label });
  return { record, token };
}
