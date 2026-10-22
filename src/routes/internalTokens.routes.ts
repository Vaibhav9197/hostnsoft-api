import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { PERMISSIONS } from "../lib/permissions";
import { findLiveDeployToken, tokenActorOf } from "../services/deployTokenAuth";
import { accessActorOf, checkAppAccess } from "../services/tokenAccess";
import { buildInvalidTokenGuidance, buildTokenSteps } from "../lib/orphanMessage";

export const internalTokensRouter = Router();

const validateSchema = z.object({
  token: z.string().min(1),
  // Optional, added with user tokens (2026-10-21): "and may it do this to
  // this app?". hostnsoft-deploy's status/logs/feedback routes used to
  // answer that themselves by comparing companyId with the app's — which is
  // still the whole answer for a workspace token, but not for a user token,
  // whose reach is its person's (services/tokenAccess.ts). Asking here keeps
  // that decision in one place.
  appName: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  permission: z.enum(PERMISSIONS).default("app.view"),
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
  const { token, appName, permission } = validateSchema.parse(req.body);

  const record = await findLiveDeployToken(token);
  if (!record) {
    // `guidance` is for hostnsoft-deploy to relay in its own 401 body so an
    // agent learns how to obtain a token (dashboard or public email
    // endpoint) — see src/lib/orphanMessage.ts. Wiring it into that repo's
    // response is a follow-up there.
    return res.json({ valid: false, guidance: buildInvalidTokenGuidance(), howToGetToken: buildTokenSteps() });
  }

  // appAccess: true/false when appName was sent and names a claimed app;
  // absent otherwise (unknown or orphan app — the caller's own lookup
  // already handles both). appRefusal: the explanation a caller with a stake
  // in the app gets instead of a bare 404 (app_moved / no_access).
  let app: { appAccess: boolean; appRefusal?: { status: number; code: string; error: string } } | null = null;
  if (appName) {
    const project = await prisma.project.findUnique({ where: { slug: appName } });
    if (project && !project.isOrphan) {
      const access = await checkAppAccess(accessActorOf(tokenActorOf(record)), project, permission, { appName });
      app = access.ok
        ? { appAccess: true }
        : {
          appAccess: false,
          ...(access.refusal
            ? { appRefusal: { status: access.refusal.status, code: access.refusal.code, error: access.refusal.reason } }
            : {}),
        };
    }
  }

  res.json({
    valid: true,
    // For a user token: its default workspace, not a limit on what it reaches.
    companyId: record.companyId,
    kind: tokenActorOf(record).kind,
    tokenId: record.id,
    label: record.label,
    ...(app ?? {}),
  });
});
