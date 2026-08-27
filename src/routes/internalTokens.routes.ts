import { Router } from "express";
import { z } from "zod";
import { findLiveDeployToken } from "../services/deployTokenAuth";

export const internalTokensRouter = Router();

const validateSchema = z.object({
  companyId: z.string().min(1),
  token: z.string().min(1),
});

// Called by hostnsoft-deploy (server-to-server, not by end users) on
// every deploy request to check whether the caller's Authorization token
// is a live, non-revoked deploy token for the companyId it claims to be
// deploying as. Deliberately no requireAuth here — knowing the raw token
// (a 256-bit secret, see src/lib/deployTokens.ts) already is the
// credential; this just confirms it against the DB. Returns a bare
// boolean rather than a reason, so a caller without the real token can't
// distinguish "wrong company" from "token doesn't exist" from "revoked".
//
// TODO: no rate limiting yet, and this should ideally also be restricted
// at the network level to only hostnsoft-deploy's host — see
// docs/CLAUDE.md's known infra gaps.
internalTokensRouter.post("/internal/deploy-tokens/validate", async (req, res) => {
  const { companyId, token } = validateSchema.parse(req.body);

  const record = await findLiveDeployToken(companyId, token);
  if (!record) {
    return res.json({ valid: false });
  }

  res.json({ valid: true, tokenId: record.id, label: record.label });
});
