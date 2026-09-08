import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { logAudit } from "../services/audit";
import { generateDeployToken, type DeployTokenSource } from "../lib/deployTokens";

// Everything in this router is a logged-in person acting in the UI.
const SOURCE: DeployTokenSource = "dashboard";

export const tokensRouter = Router();
tokensRouter.use(requireProxyToken);

// A rotated token stays valid for this long after its replacement is
// issued, so an in-flight CI run doesn't break the instant a token
// rotates. See docs/CLAUDE.md "Tokens".
const ROTATION_GRACE_MS = 60 * 60 * 1000; // 1 hour

const createTokenSchema = z.object({ label: z.string().min(1) });

// Company-wide scope (confirmed — docs/CLAUDE.md "Open questions" #1):
// this token authenticates as "any project in this company" when calling
// hostnsoft-deploy, matching its current single-shared-PLATFORM_TOKEN model.
// The raw token is returned exactly once, here, and never again.
tokensRouter.post(
  "/companies/:companyId/tokens",
  loadCompanyContext,
  async (req, res) => {
    const { label } = createTokenSchema.parse(req.body);
    const { token, prefix, tokenHash } = generateDeployToken();

    const record = await prisma.deployToken.create({
      data: { companyId: req.company!.id, createdBy: req.userId!, label, tokenHash, tokenPrefix: prefix, source: SOURCE },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      action: "token.create",
      details: label,
    });

    res.status(201).json({
      id: record.id,
      label: record.label,
      prefix: record.tokenPrefix,
      createdAt: record.createdAt,
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
      select: {
        id: true,
        label: true,
        tokenPrefix: true,
        createdAt: true,
        revokedAt: true,
        lastUsedAt: true,
        source: true,
      },
    });
    res.json(tokens);
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
        data: { companyId: req.company!.id, createdBy: req.userId!, label: old.label, tokenHash, tokenPrefix: prefix, source: SOURCE },
      }),
    ]);

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      action: "token.rotate",
      details: old.label,
    });

    res.status(201).json({
      id: replacement.id,
      label: replacement.label,
      prefix: replacement.tokenPrefix,
      createdAt: replacement.createdAt,
      token,
      oldTokenValidUntil: old.revokedAt ?? new Date(Date.now() + ROTATION_GRACE_MS),
    });
  }
);
