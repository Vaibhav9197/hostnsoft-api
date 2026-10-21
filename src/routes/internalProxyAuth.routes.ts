import { Router } from "express";
import { z } from "zod";
import { verifyProxyAuthToken, isCompanyMember, ProxyError } from "../lib/msg91";
import { requireInternalSecret } from "../middleware/requireInternalSecret";
import { canReadApp } from "../services/appReadAccess";

export const internalProxyAuthRouter = Router();

const verifySchema = z.object({
  proxyAuthToken: z.string().min(1),
  companyId: z.string().min(1),
  // Optional, added with roles: the app being read. When sent, the reply
  // also says whether this person may read that app (app.logs — the same
  // level as status), so a member limited to "selected" apps can't read
  // the others' status/logs through hostnsoft-deploy. Omitted = the old
  // membership-only answer, so an older hostnsoft-deploy keeps working.
  appName: z.string().min(1).optional(),
});

// Called by hostnsoft-deploy (server-to-server) so GET /apps/:appName/status,
// .../logs, and .../customer-query (all sharing one authorizeAppAccess
// helper in server.js) can ALSO be reached with a dashboard proxy_auth_token,
// not just a deploy token, once an app is claimed. Unlike a deploy token —
// which is minted per-company and carries its own companyId — a
// proxy_auth_token isn't itself scoped to one company (a person can belong
// to several), so the caller has to say which company's app is being
// checked; this answers "is this PAT valid, and if so, is its owner a
// member of THAT specific company" — never "which companies is this person
// in" (that's GET /companies, a dashboard-only route, not this one's job).
//
// Gated by requireInternalSecret — unlike /internal/deploy-tokens/validate
// (where knowing the raw token IS the credential), a proxy_auth_token is a
// far more powerful credential than a company-scoped deploy token (it's
// the same one that drives the whole dashboard), so this additionally
// requires proof of being called from hostnsoft-deploy itself.
internalProxyAuthRouter.post(
  "/internal/proxy-auth/verify-membership",
  requireInternalSecret,
  async (req, res) => {
    const { proxyAuthToken, companyId, appName } = verifySchema.parse(req.body);

    let identity;
    try {
      identity = await verifyProxyAuthToken(proxyAuthToken);
    } catch (err) {
      // A rejected PAT is a normal "no" here, not an error — matches
      // /internal/deploy-tokens/validate's own "always 200, check the
      // field" shape. Anything else (e.g. PROXY_UNAVAILABLE) propagates
      // as a real 5xx via errorHandler rather than being reported as
      // "invalid" — hostnsoft-deploy's caller already fails closed on a
      // non-2xx response, same as it does for an unreachable hostnsoft-api
      // anywhere else.
      if (err instanceof ProxyError && err.code === "PROXY_TOKEN_REJECTED") {
        return res.json({ valid: false, isMember: false });
      }
      throw err;
    }

    const isMember = await isCompanyMember(identity.id, companyId);
    if (!appName) return res.json({ valid: true, isMember });
    res.json({ valid: true, isMember, appAccess: isMember && (await canReadApp(identity.id, companyId, appName)) });
  }
);
