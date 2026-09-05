import type { Request, Response, NextFunction } from "express";
import { verifyProxyAuthToken } from "../lib/msg91";

// The sole auth guard for human (dashboard) routes. The dashboard keeps the
// PAT from the MSG91 widget and sends it on every request; the PAT is the
// identity — there is no local session or JWT. Verification is cached in
// lib/msg91, so this is usually not an extra proxy round-trip.
//
// Missing header is 400, not 401, so a misconfigured client sees "send the
// header" rather than "log in again". A rejected PAT propagates as
// ProxyError (401, code PROXY_TOKEN_REJECTED).
export async function requireProxyToken(req: Request, res: Response, next: NextFunction) {
  const proxyAuthToken = req.get("proxy_auth_token");
  if (!proxyAuthToken) {
    return res
      .status(400)
      .json({ error: "Missing proxy_auth_token header", code: "PROXY_TOKEN_MISSING" });
  }

  const identity = await verifyProxyAuthToken(proxyAuthToken);
  req.userId = identity.id;
  req.proxyAuthToken = proxyAuthToken;
  req.proxyIdentity = identity;
  next();
}
