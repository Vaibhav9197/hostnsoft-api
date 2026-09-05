import { Router } from "express";
import { z } from "zod";
import { findLiveDeployToken } from "../services/deployTokenAuth";

export const internalTokensRouter = Router();

const validateSchema = z.object({
  token: z.string().min(1),
});

// Called by hostnsoft-deploy (server-to-server, not by end users) on
// every deploy request to check whether the caller's Authorization token
// is a live, non-revoked deploy token. Deliberately no requireProxyToken here —
// knowing the raw token (a 256-bit secret, see src/lib/deployTokens.ts)
// already is the credential; this just confirms it against the DB.
// Returns the token's own companyId — the token IS the company identity,
// hostnsoft-deploy no longer needs (or sends) a separate X-Company-Id.
//
// TODO: no rate limiting yet, and this should ideally also be restricted
// at the network level to only hostnsoft-deploy's host — see
// docs/CLAUDE.md's known infra gaps.
internalTokensRouter.post("/internal/deploy-tokens/validate", async (req, res) => {
  const { token } = validateSchema.parse(req.body);

  const record = await findLiveDeployToken(token);
  if (!record) {
    return res.json({ valid: false });
  }

  res.json({ valid: true, companyId: record.companyId, tokenId: record.id, label: record.label });
});
