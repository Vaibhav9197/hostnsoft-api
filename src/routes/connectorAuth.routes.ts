import { Router, type Request } from "express";
import { z } from "zod";
import { verifyProxyAuthToken, getCompanyById } from "../lib/msg91";
import { findLiveDeployToken } from "../services/deployTokenAuth";
import { mintConnectorToken } from "../services/connectorToken";
import { createLimiter } from "../lib/rateLimit";
import {
  CONNECTOR_TOKEN_RATE_WINDOW_MS,
  CONNECTOR_TOKEN_EXCHANGE_RATE_PER_IP,
  CONNECTOR_TOKEN_VALIDATE_RATE_PER_IP,
} from "../lib/connectorTokenConfig";

// The two APIs an AI client (a ChatGPT/Claude "connector") needs to deploy
// to Embarko without ever seeing a copy-pasted token. The login page itself
// is MSG91 proxy's hosted widget — out of scope here, same widget the
// dashboard already uses (see docs/CLAUDE.md "Auth flow" #1). Once that
// widget hands the AI client a proxy_auth_token, these two routes are the
// entire rest of the flow:
//   1. POST /connector/token       — exchange the proxy_auth_token for a
//      company-scoped deploy token (the actual credential used against
//      hostnsoft-deploy from here on — see docs/CLAUDE.md "Auth flow" #2).
//   2. POST /connector/token/validate — given a deploy token, is it still
//      live and whose account (company) is it scoped to.
//
// Neither route calls requireProxyToken (the credential for each arrives in
// the body, not the proxy_auth_token header), so — same routing gotcha as
// every other no-auth router — this MUST be mounted in routes/index.ts
// before any router that runs `.use(requireProxyToken)` unconditionally on
// itself, or those swallow the request with a 401 first.
export const connectorAuthRouter = Router();

function ipLimiter(keyPrefix: string, requestLabel: string, limit: number) {
  return createLimiter(keyPrefix, requestLabel, "ip", limit, CONNECTOR_TOKEN_RATE_WINDOW_MS, (req: Request) => req.ip ?? "unknown");
}

const exchangeSchema = z.object({ token: z.string().min(1) });

// `token` here is the proxy_auth_token the AI client's embedded MSG91
// login just produced — "the login result" in the user's own framing.
// Mints a brand-new deploy token every call (same non-rotating shape as
// the public email endpoint's mintEmailToken) scoped to the identity's
// CURRENT company, matching how /auth/msg91/exchange already picks a
// company for a fresh login. An account with no current company (rare —
// proxy auto-creates a default one on first login) can't be handed a
// token to a company that doesn't exist, so that's a 409 telling the
// person to finish setup on the dashboard first, not a 500.
connectorAuthRouter.post(
  "/connector/token",
  ipLimiter("connector-exchange", "connector token requests", CONNECTOR_TOKEN_EXCHANGE_RATE_PER_IP),
  async (req, res) => {
    const { token } = exchangeSchema.parse(req.body);

    // A rejected token propagates as ProxyError -> 401 via errorHandler,
    // same as /auth/msg91/exchange.
    const identity = await verifyProxyAuthToken(token);

    if (!identity.company) {
      return res.status(409).json({
        error: "no_company",
        message:
          "This account has no company yet. Finish setup on the Embarko dashboard, then reconnect.",
      });
    }

    const { record, token: accessToken } = await mintConnectorToken(identity.company.id, {
      userId: identity.id,
    });

    res.status(201).json({
      accessToken, // shown once — the AI client must store this now
      tokenId: record.id,
      label: record.label,
      companyId: record.companyId,
      companyName: identity.company.name,
      createdAt: record.createdAt,
    });
  }
);

const validateSchema = z.object({ token: z.string().min(1) });

// `token` here is a deploy token (from this endpoint, the dashboard, or the
// public email endpoint — all three are ordinary DeployToken rows, this
// doesn't care which minted it). Deliberately separate from
// /internal/deploy-tokens/validate: that route is reserved for
// hostnsoft-deploy's own server-to-server calls (its own comment flags it
// for eventual network-level restriction to hostnsoft-deploy's host) and
// returns bare identifiers only. This one is meant for the wider internet
// (an AI platform's backend introspecting a token it's holding), so it
// resolves companyId to a human-readable companyName too — "whose account
// it belongs to" in the user's own framing, not just an opaque id.
connectorAuthRouter.post(
  "/connector/token/validate",
  ipLimiter("connector-validate", "connector token validation requests", CONNECTOR_TOKEN_VALIDATE_RATE_PER_IP),
  async (req, res) => {
    const { token } = validateSchema.parse(req.body);

    const record = await findLiveDeployToken(token);
    if (!record) {
      return res.json({ valid: false });
    }

    // Best-effort company name: proxy being briefly unavailable shouldn't
    // turn "is this token valid" into a 5xx — the token's own validity
    // already answered the question that matters most.
    const company = await getCompanyById(record.companyId).catch(() => null);

    res.json({
      valid: true,
      companyId: record.companyId,
      companyName: company?.name ?? null,
      tokenId: record.id,
      label: record.label,
      lastUsedAt: record.lastUsedAt,
    });
  }
);
