import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { logAudit } from "../services/audit";
import {
  DEFAULT_DEPLOY_TOKEN_KIND,
  DEPLOY_TOKEN_KINDS,
  generateDeployToken,
  type DeployTokenSource,
} from "../lib/deployTokens";
import { can } from "../lib/permissions";

// Everything in this router is a logged-in person acting in the UI.
const SOURCE: DeployTokenSource = "dashboard";

export const tokensRouter = Router();
tokensRouter.use(requireProxyToken);

// A rotated token stays valid for this long after its replacement is
// issued, so an in-flight CI run doesn't break the instant a token
// rotates. See docs/CLAUDE.md "Tokens".
const ROTATION_GRACE_MS = 60 * 60 * 1000; // 1 hour

// kind (2026-10-21): "user" — the token acts as the person creating it, in
// every workspace they are in, with this workspace as the one its new apps
// go to; "workspace" — this workspace's apps only, whoever made it (CI, a
// shared machine). Defaults to "user": a token made here is almost always
// pasted into the creator's own AI agent, and that agent should follow the
// person's apps wherever they move them. See schema.prisma's DeployToken.
const createTokenSchema = z.object({
  label: z.string().min(1),
  kind: z.enum(DEPLOY_TOKEN_KINDS).default(DEFAULT_DEPLOY_TOKEN_KIND),
});

// Every token response carries the same fields, so the dashboard reads one
// shape from create, rotate and list (plus `token` on the first two only).
// createdBy says whose a "user" token is: everyone in the workspace sees
// the list, and a personal token reaches its owner's other workspaces too.
const TOKEN_FIELDS = {
  id: true,
  label: true,
  tokenPrefix: true,
  createdAt: true,
  revokedAt: true,
  lastUsedAt: true,
  source: true,
  kind: true,
  createdBy: true,
} as const;

type TokenRow = {
  id: string; label: string; tokenPrefix: string; createdAt: Date; revokedAt: Date | null;
  lastUsedAt: Date | null; source: string; kind: string; createdBy: string;
};

function tokenView(t: TokenRow) {
  return {
    id: t.id,
    label: t.label,
    tokenPrefix: t.tokenPrefix,
    // Kept for existing callers of create/rotate, which always read `prefix`.
    prefix: t.tokenPrefix,
    createdAt: t.createdAt,
    revokedAt: t.revokedAt,
    lastUsedAt: t.lastUsedAt,
    source: t.source,
    kind: t.kind === "user" ? "user" : "workspace",
    createdBy: t.createdBy,
  };
}

// Who may manage tokens here. Membership is already established by
// loadCompanyContext; can() is the hook roles will tighten.
async function refuseUnlessTokensManage(userId: string, companyId: string) {
  return (await can(userId, companyId, "tokens.manage"))
    ? null
    : { error: "You don't have permission to manage deploy tokens in this workspace.", code: "no_access" };
}

// Scope is the token's kind — see createTokenSchema above and
// docs/CLAUDE.md "Open questions" #1. The raw token is returned exactly
// once, here, and never again.
tokensRouter.post(
  "/companies/:companyId/tokens",
  loadCompanyContext,
  async (req, res) => {
    const { label, kind } = createTokenSchema.parse(req.body);
    const denied = await refuseUnlessTokensManage(req.userId!, req.company!.id);
    if (denied) return res.status(403).json(denied);
    const { token, prefix, tokenHash } = generateDeployToken();

    const record = await prisma.deployToken.create({
      data: { companyId: req.company!.id, createdBy: req.userId!, label, tokenHash, tokenPrefix: prefix, source: SOURCE, kind },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      action: "token.create",
      details: `${label} (${kind})`,
    });

    res.status(201).json({
      ...tokenView(record),
      token, // shown once — the caller must store this now
    });
  }
);

tokensRouter.get(
  "/companies/:companyId/tokens",
  loadCompanyContext,
  async (req, res) => {
    const tokens = await prisma.deployToken.findMany({
      where: { companyId: req.company!.id },
      select: TOKEN_FIELDS,
    });
    res.json(tokens.map(tokenView));
  }
);

tokensRouter.delete(
  "/companies/:companyId/tokens/:tokenId",
  loadCompanyContext,
  async (req, res) => {
    // Scoped to this company — a bare-id update would let a member of ANY
    // company revoke another company's token just by knowing its id.
    const existing = await prisma.deployToken.findFirst({
      where: { id: req.params.tokenId, companyId: req.company!.id },
    });
    if (!existing) return res.status(404).json({ error: "Token not found" });
    const denied = await refuseUnlessTokensManage(req.userId!, req.company!.id);
    if (denied) return res.status(403).json(denied);

    const token = await prisma.deployToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      action: "token.revoke",
      details: token.label,
    });
    res.status(204).end();
  }
);

// Creates a replacement token under the same label; the old token is
// given a grace-period revocation (ROTATION_GRACE_MS out) rather than an
// instant cutover. See docs/CLAUDE.md "Tokens".
tokensRouter.post(
  "/companies/:companyId/tokens/:tokenId/rotate",
  loadCompanyContext,
  async (req, res) => {
    const old = await prisma.deployToken.findFirst({
      where: { id: req.params.tokenId, companyId: req.company!.id },
    });
    if (!old) return res.status(404).json({ error: "Token not found" });
    const denied = await refuseUnlessTokensManage(req.userId!, req.company!.id);
    if (denied) return res.status(403).json(denied);

    const { token, prefix, tokenHash } = generateDeployToken();

    const [, replacement] = await prisma.$transaction([
      prisma.deployToken.update({
        where: { id: old.id },
        data: {
          revokedAt: old.revokedAt ?? new Date(Date.now() + ROTATION_GRACE_MS),
        },
      }),
      prisma.deployToken.create({
        // A rotation is a UI action even when the old token came from an agent.
        // It keeps the kind: whoever holds the old token expects the new one
        // to reach the same apps. createdBy moves to the rotator, so a
        // rotated user token acts as the person who rotated it — the one
        // who will paste it — not as whoever made the original.
        data: { companyId: req.company!.id, createdBy: req.userId!, label: old.label, tokenHash, tokenPrefix: prefix, source: SOURCE, kind: old.kind },
      }),
    ]);

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      action: "token.rotate",
      details: old.label,
    });

    res.status(201).json({
      ...tokenView(replacement),
      token,
      oldTokenValidUntil: old.revokedAt ?? new Date(Date.now() + ROTATION_GRACE_MS),
    });
  }
);
