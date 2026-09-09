import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getCompanyById } from "../lib/msg91";
import { requireProxyToken } from "../middleware/proxyToken";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";

export const adminRouter = Router();

adminRouter.use(requireProxyToken);
adminRouter.use(requireSuperAdmin);

// GET /admin/apps — every app across every company, super-admin only. See
// docs/admin-panel.md Part 4. Real data throughout: Project/Deployment are
// the same tables the rest of the API reads/writes, and companyName comes
// from proxy (getCompanyById, already TTL-cached) — nothing here is mocked.
adminRouter.get("/admin/apps", async (req, res) => {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      deployments: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { deployments: true } },
    },
  });

  // Batch-resolve company names once per unique companyId rather than once
  // per project — getCompanyById is already TTL-cached, but no reason to
  // pay even a cache-lookup cost per row when many apps share a company.
  const companyIds = [...new Set(projects.map((p) => p.companyId).filter((id): id is string => !!id))];
  const companies = await Promise.all(companyIds.map((id) => getCompanyById(id)));
  const companyNameById = new Map(companyIds.map((id, i) => [id, companies[i]?.name ?? "Unknown company"]));

  const apps = projects.map((p) => {
    const latest = p.deployments[0];
    return {
      appSlug: p.slug,
      companyName: p.companyId ? companyNameById.get(p.companyId)! : "Unclaimed (orphan)",
      createdAt: p.createdAt.toISOString(),
      // Project.memoryMb is the platform's own source of truth for current
      // allocation (kept in sync on every successful deploy, never
      // downward — see internalDeployments.routes.ts) rather than reading
      // it back off the latest deployment row, which can be null/stale on
      // a failed or still-in-progress attempt.
      memoryMb: p.memoryMb,
      deploymentCount: p._count.deployments,
      status: latest?.status ?? "no_deployments",
    };
  });

  res.json(apps);
});
