import type { Request, Response, NextFunction } from "express";
import { getCompanyById, isCompanyMember } from "../lib/msg91";
import { ensureCompanyPage, hasCompanyPage } from "../services/showcase";

// Authorizes the caller for :companyId (a proxy company id) by asking proxy
// for membership. Must run after requireProxyToken, which sets req.userId.
// Membership is the only check — proxy has no per-user role, so any member
// may do anything here.
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
    return res.status(404).json({ error: "Company not found" });
  }

  if (!(await isCompanyMember(req.userId!, companyId))) {
    return res.status(404).json({ error: "Company not found" });
  }

  req.company = { id: companyId };

  // Every company the dashboard touches passes through here, whichever way
  // it became active (login default, stored choice, or a switch), so this
  // is where a company that predates Showcase gets its reserved page. One
  // Redis read once the page exists; never throws (docs/showcase.md).
  if (!(await hasCompanyPage(companyId))) {
    const company = await getCompanyById(companyId).catch(() => null);
    if (company) await ensureCompanyPage(company, req.userId!);
  }

  next();
}
