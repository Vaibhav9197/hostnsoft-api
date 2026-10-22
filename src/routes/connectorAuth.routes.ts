import { Router, type Request, urlencoded as expressUrlencoded } from "express";
import { z } from "zod";
import { verifyProxyAuthToken } from "../lib/msg91";
import { findLiveDeployToken, tokenActorOf } from "../services/deployTokenAuth";
import { mintConnectorToken } from "../services/connectorToken";
import { redeemPendingLoginCode } from "../lib/connectorPendingLogin";
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
//   2. GET /connector/token/validate  — given a deploy token (as a Bearer
//      header), is it still live and whose account (company) is it scoped
//      to.
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

// Accepts either a JSON body (direct API testing) or a standard OAuth-style
// form-encoded token request (application/x-www-form-urlencoded) - the
// latter is what a generic OAuth proxy (e.g. viasocket-mcp) sends without
// any Embarko-specific handling. `client_id`/`client_secret`/`redirect_uri`/
// `grant_type` may be present on that request; we don't need them (this
// endpoint trusts the proxy_auth_token itself), so they're simply ignored.
const formBodyParser = expressUrlencoded({ extended: false });

const exchangeSchema = z
  .object({
    // `token`: this endpoint's own original field name - a proxy_auth_token
    // presented directly (a direct/JSON caller that already holds a live
    // PAT, not routed through the redirect flow below).
    token: z.string().min(1).optional(),
    // `code`: the standard OAuth authorization-code field name, used when a
    // generic OAuth proxy exchanges the redirect result. This is NOT the
    // PAT itself - GET /auth/msg91/callback hands out a single-use, short-TTL
    // opaque code instead of the PAT (see connectorPendingLogin.ts's own
    // comment for why), so this is always redeemed via Redis first.
    code: z.string().min(1).optional(),
  })
  .refine((v) => v.token || v.code, { message: "token or code is required" });

// `token` is a proxy_auth_token presented directly; `code` is redeemed
// (single-use) for the proxy_auth_token it was issued for. Either way, once
// resolved, this is "the login result" in the user's own framing. Mints a
// brand-new deploy token every call (same non-rotating shape as the public
// email endpoint's mintEmailToken) scoped to the identity's CURRENT
// company, matching how /auth/msg91/exchange already picks a company for a
// fresh login. An account with no current company (rare — proxy
// auto-creates a default one on first login) can't be handed a token to a
// company that doesn't exist, so that's a 409 telling the person to finish
// setup on the dashboard first, not a 500.
connectorAuthRouter.post(
  "/connector/token",
  formBodyParser,
  ipLimiter("connector-exchange", "connector token requests", CONNECTOR_TOKEN_EXCHANGE_RATE_PER_IP),
  async (req, res) => {
    const { token, code } = exchangeSchema.parse(req.body);

    let proxyAuthToken: string;
    if (token) {
      proxyAuthToken = token;
    } else {
      const redeemed = await redeemPendingLoginCode(code as string);
      if (!redeemed) {
        return res.status(400).json({
          error: "invalid_grant",
          message: "This code is invalid, expired, or already used. Start the connection again from your AI client.",
        });
      }
      proxyAuthToken = redeemed;
    }

    // A rejected token propagates as ProxyError -> 401 via errorHandler,
    // same as /auth/msg91/exchange.
    const identity = await verifyProxyAuthToken(proxyAuthToken);

    if (!identity.company) {
      return res.status(409).json({
        error: "no_company",
        message:
          "This account has no workspace yet. Finish setup on the Embarko dashboard, then reconnect.",
      });
    }

    const { record, token: accessToken } = await mintConnectorToken(identity.company.id, {
      userId: identity.id,
    });

    res.status(201).json({
      // access_token: standard OAuth token-response field name, for a
      // generic OAuth proxy parsing this as a normal token endpoint.
      access_token: accessToken,
      token_type: "bearer",
      accessToken, // kept for existing/direct callers - shown once either way
      tokenId: record.id,
      label: record.label,
      // A user token (services/connectorToken.ts): it reaches every workspace
      // this person is in; companyId/companyName are where new apps go.
      kind: record.kind,
      companyId: record.companyId,
      companyName: identity.company.name,
      createdAt: record.createdAt,
    });
  }
);

// `token` here is a deploy token (from this endpoint, the dashboard, or the
// public email endpoint — all three are ordinary DeployToken rows, this
// doesn't care which minted it). Deliberately separate from
// /internal/deploy-tokens/validate: that route is reserved for
// hostnsoft-deploy's own server-to-server calls (its own comment flags it
// for eventual network-level restriction to hostnsoft-deploy's host) and
// returns bare identifiers only. This one is meant for the wider internet
// (an AI platform's backend introspecting a token it's holding) — a
// generic OAuth/API-key proxy (e.g. viasocket-mcp) that validates a stored
// credential by sending it in an Authorization header and reading the HTTP
// status code, not a JSON body, to decide pass/fail. This is what actually
// lets tool calls (not just login) succeed for a generic MCP proxy —
// without it, every request after a successful login still gets rejected
// at the per-request token check.
connectorAuthRouter.get(
  "/connector/token/validate",
  ipLimiter("connector-validate-header", "connector token validation requests", CONNECTOR_TOKEN_VALIDATE_RATE_PER_IP),
  async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : authHeader;

    if (!token) {
      return res.status(400).json({ error: "missing_token", message: "Authorization header is required" });
    }

    const record = await findLiveDeployToken(token);
    if (!record) {
      return res.status(401).json({ valid: false });
    }

    // kind: "user" (reaches whatever its person can; companyId is only where
    // new apps go) or "workspace" (companyId's apps only).
    res.status(200).json({ valid: true, companyId: record.companyId, kind: tokenActorOf(record).kind, tokenId: record.id });
  }
);
