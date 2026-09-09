import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getCompanyById } from "../lib/msg91";
import { requireProxyToken } from "../middleware/proxyToken";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import { featureRequestTypeSchema } from "../services/featureRequests";

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

const featureRequestQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  // Exact-match filters — structured/enum-like fields.
  type: featureRequestTypeSchema.optional(),
  source: z.enum(["dashboard", "public", "agent"]).optional(),
  companyId: z.string().min(1).optional(),
  projectSlug: z.string().min(1).optional(),
  // Substring, case-insensitive-by-default on SQLite — free-text fields
  // someone triaging is more likely to search than match exactly.
  agentName: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  // Inclusive range over createdAt — either end optional.
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
});

// GET /admin/feature-requests — every submission across every path
// (dashboard/public/agent), paginated, filterable on every stored field.
// See docs/request-feature-req.md for the three submission paths and
// docs/admin-panel.md for the access model this reuses. Real data
// throughout — reads the same FeatureRequest table every submission
// route writes to, nothing mocked.
adminRouter.get("/admin/feature-requests", async (req, res) => {
  const query = featureRequestQuerySchema.parse(req.query);

  const where: Prisma.FeatureRequestWhereInput = {
    ...(query.type && { type: query.type }),
    ...(query.source && { source: query.source }),
    ...(query.companyId && { companyId: query.companyId }),
    ...(query.projectSlug && { projectSlug: query.projectSlug }),
    ...(query.agentName && { agentName: { contains: query.agentName } }),
    ...(query.email && { email: { contains: query.email } }),
    ...((query.createdFrom || query.createdTo) && {
      createdAt: {
        ...(query.createdFrom && { gte: query.createdFrom }),
        ...(query.createdTo && { lte: query.createdTo }),
      },
    }),
  };

  const [total, items] = await Promise.all([
    prisma.featureRequest.count({ where }),
    prisma.featureRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  res.json({
    items,
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.ceil(total / query.limit),
  });
});
