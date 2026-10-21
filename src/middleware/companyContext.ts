import type { Request, Response, NextFunction } from "express";
import { getCompanyById, isCompanyMember } from "../lib/msg91";

// Authorizes the caller for :companyId (a proxy company id) by asking proxy
// for membership. Must run after requireProxyToken, which sets req.userId.
// This is only the "are they in at all" half: what a member may do there is
// middleware/requirePermission.ts, which every route puts after this (and
// after loadProjectContext where there is one).
//
// Non-members get 404, not 403, so the company's existence isn't confirmed
// to outsiders. A proxy outage throws instead, surfacing as 503.
//
// The URL's company may differ from proxy's "current" company; scope comes
// from the URL every request. POST /auth/switch-company exists only to keep
// the proxy embed in step with the dashboard.
export async function loadCompanyContext(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { companyId } = req.params;
  if (!companyId) {
    return res.status(404).json({ error: "Workspace not found" });
  }

  if (!(await isCompanyMember(req.userId!, companyId))) {
    return res.status(404).json({ error: "Workspace not found" });
  }

  req.company = { id: companyId };
  req.membershipChecked = true;
  next();
}
