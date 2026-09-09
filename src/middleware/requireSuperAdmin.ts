import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "../lib/superAdmin";

// Gate for every /admin/* route — see docs/admin-panel.md Part 3. Must run
// after requireProxyToken, which sets req.userId.
//
// Always 404, never 401/403: a 403 confirms to a non-admin that the route
// exists and they're deliberately blocked, which is exactly what this is
// built to avoid. 404 makes an admin route indistinguishable from a URL
// that was never registered. This must hold for every caller, admin or
// not — the check itself never throws or short-circuits differently.
export async function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!(await isSuperAdmin(req.userId!))) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}
