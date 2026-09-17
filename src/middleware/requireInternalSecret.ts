import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { INTERNAL_API_SECRET } from "../lib/internalDeployClient";

// Authenticates hostnsoft-deploy's own calls INTO this service — the
// reverse of every other use of INTERNAL_API_SECRET in this codebase
// (which is otherwise always this service calling INTO hostnsoft-deploy,
// see lib/internalDeployClient.ts's own comment). Nothing stops the same
// shared secret being checked in both directions; this is currently used
// by the async rollback completion callback (see
// internalDeployments.routes.ts's POST .../complete), by
// /internal/proxy-auth/verify-membership, and by the proxy_auth_token
// branch of the deploy endpoints (see services/deployActor.ts) —
// hostnsoft-deploy's server.js has the mirror-image requireInternalSecret
// already.
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// The same check as the middleware below, as a plain predicate — for
// endpoints where only SOME requests need it (services/deployActor.ts
// demands it for the proxy_auth_token branch only, leaving the deploy-
// token and anonymous branches exactly as they were).
export function hasInternalSecret(req: Request): boolean {
  const provided = req.get("x-internal-secret");
  return typeof provided === "string" && constantTimeEquals(provided, INTERNAL_API_SECRET);
}

export function requireInternalSecret(req: Request, res: Response, next: NextFunction) {
  if (!hasInternalSecret(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
