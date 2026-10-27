import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getCompanyById, getUserByEmail, getUserById } from "../lib/msg91";
import { requireProxyToken } from "../middleware/proxyToken";
import { requireSuperAdmin } from "../middleware/requireSuperAdmin";
import { featureRequestTypeSchema } from "../services/featureRequests";
import { fetchAdminOverview, needsAttention, problemsFor } from "../services/adminOverview";
import { API_PUBLIC_URL } from "../lib/publicTokenConfig";

export const adminRouter = Router();

adminRouter.use(requireProxyToken);
adminRouter.use(requireSuperAdmin);

// GET /admin/apps — every customer app across every company, super-admin
// only: the admin panel's Customer apps page. Project/Deployment are the
// same tables the rest of the API reads/writes, and companyName comes from
// proxy (getCompanyById, already TTL-cached). Since 2026-10-27 each app also
// carries its live runtime (health, memory against its limit, restarts,
// out-of-memory kills, failed wake-ups) and `problems`, from one call to
// hostnsoft-deploy (services/adminOverview.ts). When that call fails the
// list still answers, with `runtime.available: false` and the per-app
// runtime fields null, rather than not at all.
adminRouter.get("/admin/apps", async (req, res) => {
  const [projects, { overview, error: runtimeError }] = await Promise.all([prisma.project.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      deployments: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { deployments: true } },
    },
  }), fetchAdminOverview()]);

  // Batch-resolve company names once per unique companyId rather than once
  // per project — getCompanyById is already TTL-cached, but no reason to
  // pay even a cache-lookup cost per row when many apps share a company.
  const companyIds = [...new Set(projects.map((p) => p.companyId).filter((id): id is string => !!id))];
  const companies = await Promise.all(companyIds.map((id) => getCompanyById(id)));
  const companyNameById = new Map(companyIds.map((id, i) => [id, companies[i]?.name ?? "Unknown company"]));

  const items = projects.map((p) => {
    const latest = p.deployments[0];
    const rt = overview?.apps[p.slug];
    const status = latest?.status ?? "no_deployments";
    return {
      id: p.id,
      appSlug: p.slug,
      name: p.name,
      kind: p.kind,
      isOrphan: p.isOrphan,
      companyName: p.companyId ? companyNameById.get(p.companyId)! : "Unclaimed (orphan)",
      createdAt: p.createdAt.toISOString(),
      // Project.memoryMb is the platform's own source of truth for current
      // allocation (kept in sync on every successful deploy, never
      // downward — see internalDeployments.routes.ts) rather than reading
      // it back off the latest deployment row, which can be null/stale on
      // a failed or still-in-progress attempt.
      memoryMb: p.memoryMb,
      deploymentCount: p._count.deployments,
      status,
      lastDeployAt: latest?.createdAt.toISOString() ?? null,
      // Who made the latest deploy — see schema.prisma's Deployment.source
      // and agentName. Null when there are no deployments.
      lastDeploySource: latest?.source ?? null,
      lastDeployAgentName: latest?.agentName ?? null,
      // Live runtime. A static site has no process, so none of this applies
      // to it; a never-deployed or deleted app has no Nomad job. Both: null.
      health: rt?.health ?? null,
      asleepSince: rt?.asleepSince ?? null,
      memoryLimitMb: rt?.memoryLimitMb ?? null,
      memoryUsedMb: rt?.memoryMb ?? null,
      memoryPeak24hMb: rt?.memoryPeak24hMb ?? null,
      cpuPercent: rt?.cpuPercent ?? null,
      crashes24h: rt?.crashes24h ?? null,
      lastCrashAt: rt?.lastCrashAt ?? null,
      platformRestarts24h: rt?.platformRestarts24h ?? null,
      oomKills24h: rt ? Math.max(rt.oomKills24h, rt.oomTerminations24h) : null,
      lastOom: rt?.lastOom ?? null,
      wakeFailures24h: rt?.wakeFailures24h ?? null,
      lastWakeFailure: rt?.lastWakeFailure ?? null,
      problems: problemsFor(rt, status),
    };
  });

  res.json({
    items,
    runtime: { available: overview !== null, error: runtimeError, generatedAt: overview?.generatedAt ?? null },
  });
});

// GET /admin/platform — the admin panel's Platform health page: our own
// infrastructure, not customers' apps. The platform monitor's status (see
// services/adminOverview.ts) plus a count of customer apps by health, so
// the page can say how the fleet is doing and link to Customer apps.
adminRouter.get("/admin/platform", async (_req, res) => {
  const { overview, error } = await fetchAdminOverview();
  const counts: Record<string, number> = {};
  for (const rt of Object.values(overview?.apps ?? {})) counts[rt.health] = (counts[rt.health] ?? 0) + 1;
  const attentionCount = Object.values(overview?.apps ?? {}).filter((rt) => needsAttention(problemsFor(rt, ""))).length;
  res.json({
    available: overview !== null,
    error,
    generatedAt: overview?.generatedAt ?? null,
    monitor: overview?.monitor ?? null,
    monitorStale: overview?.monitorStale ?? false,
    monitorError: overview?.monitorError ?? null,
    customerApps: { byHealth: counts, needsAttention: attentionCount },
    // Netdata's dashboard, behind its own password. server-setup.md#netdata-dashboard
    netdataUrl: `${new URL(API_PUBLIC_URL).origin}/netdata/`,
  });
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

// GET /admin/customer-query — every submission across every path
// (dashboard/public/agent), paginated, filterable on every stored field.
// See docs/request-feature-req.md for the three submission paths and
// docs/admin-panel.md for the access model this reuses. Real data
// throughout — reads the same FeatureRequest table every submission
// route writes to, nothing mocked.
adminRouter.get("/admin/customer-query", async (req, res) => {
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

const grantSuperAdminSchema = z.object({
  email: z.string().trim().email(),
});

// POST /admin/super-admins — grant super-admin to another user by email.
// Caller must already be a super admin (router-level requireSuperAdmin).
// Email is what an admin actually knows about a colleague; it's resolved to
// the proxy (MSG91) user id via getUserByEmail because SuperAdmin is keyed
// on that id — the same key requireProxyToken puts on req.userId and the
// same one scripts/grant-super-admin.ts takes. An email proxy doesn't know
// is a 404, so nothing dangling is ever written. Idempotent: granting to an
// existing admin is a no-op that still returns 200.
adminRouter.post("/admin/super-admins", async (req, res) => {
  const { email } = grantSuperAdminSchema.parse(req.body);

  const user = await getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
  }

  const existing = await prisma.superAdmin.findUnique({ where: { userId: user.id } });
  const admin = existing ?? (await prisma.superAdmin.create({ data: { userId: user.id } }));

  res.status(existing ? 200 : 201).json({
    userId: admin.userId,
    email: user.email,
    name: user.name,
    grantedAt: admin.grantedAt.toISOString(),
    grantedBy: req.userId,
    alreadyAdmin: existing !== null,
  });
});

// GET /admin/super-admins — everyone currently holding super-admin, newest
// grant first. SuperAdmin stores only userId + grantedAt, so name/email are
// resolved from proxy (getUserById, TTL-cached) the same way /admin/apps
// resolves company names. A row whose user proxy no longer knows still
// appears, with null name/email and unresolved: true — it holds real access,
// so hiding it would make the list lie about who can get in.
adminRouter.get("/admin/super-admins", async (req, res) => {
  const admins = await prisma.superAdmin.findMany({ orderBy: { grantedAt: "desc" } });

  const users = await Promise.all(admins.map((a) => getUserById(a.userId)));

  res.json(
    admins.map((admin, i) => {
      const user = users[i];
      return {
        userId: admin.userId,
        email: user?.email ?? null,
        name: user?.name ?? null,
        grantedAt: admin.grantedAt.toISOString(),
        unresolved: user === null,
        isSelf: admin.userId === req.userId,
      };
    })
  );
});

const revokeSuperAdminSchema = z.object({
  userId: z.string().min(1),
});

// DELETE /admin/super-admins/:userId — revoke super-admin. Keyed on the
// proxy user id, not email: the id is what GET /admin/super-admins returns
// for every row, including rows proxy can no longer resolve to an email,
// and those are exactly the stale grants most worth being able to remove.
//
// Two guards, both refusing rather than silently locking people out:
// self-revoke (an admin dropping their own access can't undo it — nothing
// over HTTP grants it back to a non-admin, only the script can) and
// last-admin (the SuperAdmin table emptying means /admin/* becomes
// unreachable for everyone and only scripts/grant-super-admin.ts can
// recover it).
adminRouter.delete("/admin/super-admins/:userId", async (req, res) => {
  const { userId } = revokeSuperAdminSchema.parse(req.params);

  if (userId === req.userId) {
    return res.status(400).json({
      error: "You cannot revoke your own super-admin access",
      code: "CANNOT_REVOKE_SELF",
    });
  }

  const existing = await prisma.superAdmin.findUnique({ where: { userId } });
  if (!existing) {
    return res.status(404).json({ error: "Super admin not found", code: "SUPER_ADMIN_NOT_FOUND" });
  }

  // Belt-and-braces: self-revoke is already blocked above, so a count of 1
  // here means the caller isn't in the table at all — impossible past
  // requireSuperAdmin. Kept anyway so the invariant survives the guard
  // above ever being relaxed.
  const total = await prisma.superAdmin.count();
  if (total <= 1) {
    return res.status(400).json({
      error: "Cannot revoke the last super admin",
      code: "LAST_SUPER_ADMIN",
    });
  }

  await prisma.superAdmin.delete({ where: { userId } });

  const user = await getUserById(userId);
  res.json({
    userId,
    email: user?.email ?? null,
    name: user?.name ?? null,
    revokedAt: new Date().toISOString(),
    revokedBy: req.userId,
  });
});
