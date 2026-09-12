import { Router } from "express";
import { z } from "zod";
import {
  verifyProxyAuthToken,
  getMyDetails,
  isCompanyMember,
  switchCompany,
  evictProxyAuthToken,
  ProxyError,
} from "../lib/msg91";
import { requireProxyToken } from "../middleware/proxyToken";
import { logAudit } from "../services/audit";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";
import { resolveConnectorRedirect } from "../lib/connectorRedirect";
import { createPendingLoginCode } from "../lib/connectorPendingLogin";
import { logger } from "../lib/logger";
import { ensureBillingForCompany } from "../services/billingCustomer";
import type { Msg91Identity } from "../lib/msg91";
import { isSuperAdmin } from "../lib/superAdmin";

export const authRouter = Router();

// Human login only — the deploy agent never holds a session, just a deploy
// token (docs/CLAUDE.md "Auth flow" #2).
//
// Identity and sessions are proxy's entirely: there is no local session,
// JWT, or refresh token. The proxy_auth_token (PAT) the client gets from
// the MSG91 widget IS the credential, sent on every request and verified
// (with caching) by requireProxyToken.

const exchangeSchema = z.object({ token: z.string().min(1) });

// Login is where a company created BY PROXY first becomes visible to us: a
// user who isn't in any company yet gets a default one made by proxy on
// first login, and it never passes through POST /companies. So every login
// makes sure the current company has billing. Cheap on repeat logins (a
// Redis hit), never throws, and the company's contact email is the user's —
// the only one we have for a proxy-made company.
function ensureBillingForCurrentCompany(identity: Msg91Identity) {
  if (!identity.company) return Promise.resolve("pending" as const);
  return ensureBillingForCompany(identity.company.id, {
    name: identity.company.name,
    email: identity.email,
  });
}

// Token-exchange flow ("Option B"): the widget's success callback fires
// in-page and the client POSTs the token here itself.
//
// The client must KEEP that token — it's the credential for every
// authenticated route from here on.
authRouter.post("/auth/msg91/exchange", async (req, res) => {
  const { token } = exchangeSchema.parse(req.body);

  // A rejected token propagates as ProxyError -> 401 via errorHandler.
  const identity = await verifyProxyAuthToken(token);
  const [billing, isAdmin] = await Promise.all([
    ensureBillingForCurrentCompany(identity),
    isSuperAdmin(identity.id),
  ]);

  res.json({
    // isSuperAdmin: see docs/admin-panel.md — sent so the dashboard can
    // show its admin-only routes conditionally. The /admin/* API routes
    // are the actual enforcement point regardless of what the client does
    // with this.
    user: { id: identity.id, email: identity.email, name: identity.name, isSuperAdmin: isAdmin },
    // Proxy's current company; the full list is GET /companies.
    currentCompany: identity.company,
    // "pending" -> dashboard calls POST /companies/:id/billing/customer.
    billing,
  });
});

// Only same-origin-relative paths; the origin is never taken from the
// request. Guards the open-redirect vector.
const DEFAULT_REDIRECT_PATH = "/";
function safeRedirectPath(next: unknown): string {
  if (typeof next !== "string" || next.length === 0) return DEFAULT_REDIRECT_PATH;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("://")) {
    return DEFAULT_REDIRECT_PATH;
  }
  return next;
}

// Redirect flow ("Option A"): MSG91 sends the browser here with the token in
// the query string, so this answers with a redirect, not JSON. The token is
// verified (so bad logins surface as auth_error) but not forwarded onward —
// a frontend on this flow gets its PAT from the proxy embed it already
// hosts.
function appendParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

authRouter.get("/auth/msg91/callback", async (req, res) => {
  const next = safeRedirectPath(req.query.next);
  const token = req.query.proxy_auth_token;
  // Only set when redirect_uri matches the connector allowlist; everything
  // else (the dashboard's own login) keeps redirecting to FRONTEND_ORIGIN
  // exactly as before.
  const connectorRedirect = resolveConnectorRedirect(req.query.redirect_uri);
  const target = connectorRedirect ?? `${FRONTEND_ORIGIN}${next}`;
  // The dashboard's own convention is `auth_error`; a connector redirect
  // uses the standard OAuth `error` param name instead, so a generic OAuth
  // proxy on the other end (no Embarko-specific parsing) handles it the
  // same way it would any other platform's failure response.
  const errorParam = connectorRedirect ? "error" : "auth_error";
  const connectorState = connectorRedirect && typeof req.query.state === "string" ? req.query.state : undefined;
  function errorRedirect(code: string): string {
    const url = appendParam(target, errorParam, code);
    return connectorState ? appendParam(url, "state", connectorState) : url;
  }

  if (typeof token !== "string" || token.length === 0) {
    return res.redirect(errorRedirect("missing_token"));
  }

  // The one place proxy failures are caught by hand: this response is a
  // redirect, so errorHandler's JSON body would be useless to the browser.
  let identity: Msg91Identity;
  try {
    identity = await verifyProxyAuthToken(token);
  } catch (err) {
    if (err instanceof ProxyError && err.code === "PROXY_TOKEN_REJECTED") {
      logger.warn(`[auth.msg91.callback] rejected: ${err.message}`);
      return res.redirect(errorRedirect("invalid_token"));
    }
    if (err instanceof ProxyError) {
      logger.error(`[auth.msg91.callback] proxy ${err.status}: ${err.message}`);
      return res.redirect(errorRedirect("identity_unavailable"));
    }
    throw err;
  }

  // Not awaited: the browser is being redirected and can't use the result;
  // the dashboard learns readiness from GET /companies/:id/billing.
  void ensureBillingForCurrentCompany(identity);

  // Unlike the internal dashboard redirect (whose frontend already has its
  // PAT from the widget directly), an external connector redirect needs some
  // credential forwarded - that's the whole point of this branch. It must
  // NOT be the PAT itself: this URL lands in browser history and very
  // plausibly in the receiving service's own access logs, and the PAT is
  // the same long-lived credential used for every dashboard API call, not
  // something scoped to this one handoff. So we hand over a single-use,
  // short-TTL opaque code instead (see connectorPendingLogin.ts) - POST
  // /connector/token redeems it for the real PAT server-side, once.
  // Named `code` (not `access_token`) so it lines up with the standard
  // OAuth authorization-code query param the connector's callback already
  // expects and parses the same way regardless of which platform it's
  // talking to. `state` is opaque to us - a generic OAuth proxy sends it as
  // its own top-level param (not embedded in redirect_uri), so it has to be
  // forwarded explicitly too or the caller can't match this response back
  // to the request that started it.
  if (!connectorRedirect) {
    res.redirect(target);
    return;
  }
  const pendingLoginCode = await createPendingLoginCode(token);
  const finalUrl = connectorState
    ? appendParam(appendParam(target, "code", pendingLoginCode), "state", connectorState)
    : appendParam(target, "code", pendingLoginCode);
  res.redirect(finalUrl);
});

// The frontend revokes the PAT against proxy directly on logout; our job is
// only to drop the cached identity so a revoked PAT isn't served from our
// verification cache.
authRouter.post("/auth/logout", requireProxyToken, async (req, res) => {
  await evictProxyAuthToken(req.proxyAuthToken!);
  res.status(204).end();
});

// Base identity comes from the caller's own proxy_auth_token
// (requireProxyToken — usually a cache hit from login, no extra proxy
// call). getMyDetails is the user-key GET /c/getDetails, the caller's own
// full record straight from their PAT — no id lookup needed, unlike the
// admin-key getUserById. Its result wins on overlap since it's fuller.
authRouter.get("/auth/me", requireProxyToken, async (req, res) => {
  const [details, isAdmin] = await Promise.all([
    getMyDetails(req.proxyAuthToken!),
    isSuperAdmin(req.userId!),
  ]);
  // isSuperAdmin last so it always wins over anything of the same name
  // proxy might incidentally return in req.proxyIdentity/details — this
  // is OUR flag, not proxy's, see docs/admin-panel.md.
  res.json({ ...req.proxyIdentity, ...details, isSuperAdmin: isAdmin });
});

const switchCompanySchema = z.object({ companyId: z.string().min(1) });

// Moves proxy's current company for this user. This API never reads current
// company — scope is the URL's :companyId — so nothing local changes. It
// exists because the company-aware proxy embed renders whatever proxy thinks
// is current, and must agree with the dashboard.
//
// Membership is checked with the same primitive every scoped route uses, so
// a non-member gets the same 404 and proxy is never asked to switch into a
// company the user isn't in.
authRouter.post("/auth/switch-company", requireProxyToken, async (req, res) => {
  const { companyId } = switchCompanySchema.parse(req.body);

  if (!(await isCompanyMember(req.userId!, companyId))) {
    return res.status(404).json({ error: "Company not found" });
  }

  await switchCompany(req.proxyAuthToken!, companyId);

  await logAudit({
    actorUserId: req.userId,
    companyId,
    action: "company.switch",
  });
  res.json({ companyId });
});
