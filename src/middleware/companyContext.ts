import type { Request, Response, NextFunction } from "express";
import { getCompanyById, isCompanyMember } from "../lib/msg91";
import { prisma } from "../lib/prisma";

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
  touchLastSeen(companyId, req.userId!);
  next();
}

// "Last active" on the People page. At most one write per person per
// workspace per hour from this process, never awaited, and a failure is
// ignored: it must never slow or break the request it rides on. Only
// updates an existing row — whether someone has one is permissions.ts's
// business, not this.
const SEEN_GAP_MS = 60 * 60 * 1000;
const lastTouched = new Map<string, number>();

function touchLastSeen(companyId: string, userId: string) {
  const key = `${companyId}:${userId}`;
  const now = Date.now();
  if (now - (lastTouched.get(key) ?? 0) < SEEN_GAP_MS) return;
  lastTouched.set(key, now);
  if (lastTouched.size > 50_000) lastTouched.clear();
  prisma.workspaceMember
    .updateMany({ where: { companyId, userId }, data: { lastSeenAt: new Date(now) } })
    .catch(() => undefined);
}
