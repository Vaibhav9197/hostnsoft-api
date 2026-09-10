import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { INTERNAL_API_SECRET } from "../lib/internalDeployClient";

// Authenticates hostnsoft-deploy's own calls INTO this service — the
// reverse of every other use of INTERNAL_API_SECRET in this codebase
// (which is otherwise always this service calling INTO hostnsoft-deploy,
// see lib/internalDeployClient.ts's own comment). Nothing stops the same
// shared secret being checked in both directions; this is currently only
// used by the async rollback completion callback (see
// internalDeployments.routes.ts's POST .../complete) — hostnsoft-deploy's
// server.js has the mirror-image requireInternalSecret already.
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireInternalSecret(req: Request, res: Response, next: NextFunction) {
  const provided = req.get("x-internal-secret");
  if (typeof provided !== "string" || !constantTimeEquals(provided, INTERNAL_API_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
