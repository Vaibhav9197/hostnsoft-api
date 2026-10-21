import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { requirePermission } from "../middleware/requirePermission";
import { accessAllows } from "../lib/permissions";
import { loadProjectContext } from "../middleware/projectContext";
import { fetchAppAnalytics, type AnalyticsRange } from "../services/appAnalytics";

export const analyticsRouter = Router();
analyticsRouter.use(requireProxyToken);

const rangeSchema = z.enum(["24h", "7d", "30d", "90d", "all"]).default("24h");

function parseRange(raw: unknown): AnalyticsRange {
  return rangeSchema.parse(raw);
}

// Per-project traffic (Traefik access log) and CPU/memory (Nomad stats)
// history — see hostnsoft-deploy's analytics/*.js for how this is
// actually derived. 503, not a fabricated empty result, when
// hostnsoft-deploy's analytics subsystem is unreachable or disabled —
// analytics has real optional infra (Traefik's JSON access log,
// ANALYTICS_DB_PATH) behind it, so "unavailable" and "zero traffic" are
// genuinely different things a dashboard should tell apart.
analyticsRouter.get(
  "/companies/:companyId/projects/:projectId/analytics",
  loadCompanyContext,
  loadProjectContext,
  requirePermission("app.view"),
  async (req, res) => {
    const range = parseRange(req.query.range);
    const analytics = await fetchAppAnalytics(req.project!.slug, range);
    if (!analytics) {
      return res.status(503).json({ error: "Analytics are temporarily unavailable for this project" });
    }
    res.json(analytics);
  }
);

// Account-wide rollup — sums each project's own analytics rather than
// merging time-series (averaging CPU% or memory across differently-
// sized apps isn't meaningful without weighting, so only the per-app
// CURRENT resource snapshot is summed here, not a merged series). Fans
// out to hostnsoft-deploy once per project in parallel; fine at this
// platform's per-company project counts — revisit with a bulk
// hostnsoft-deploy endpoint if that ever stops being true.
analyticsRouter.get(
  "/companies/:companyId/analytics",
  loadCompanyContext,
  requirePermission("app.view"),
  async (req, res) => {
    const range = parseRange(req.query.range);
    // Only the apps the caller can see — the rollup must not add in traffic
    // from apps that answer 404 to them one by one.
    const projects = (await prisma.project.findMany({ where: { companyId: req.company!.id } })).filter((p) =>
      accessAllows(req.access!, "app.view", p)
    );

    const perProject = await Promise.all(
      projects.map(async (project) => ({
        project,
        analytics: await fetchAppAnalytics(project.slug, range),
      }))
    );

    const totals = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
    let totalRequests = 0;
    let totalCpuPercent = 0;
    let totalMemoryMb = 0;

    const perProjectSummary = perProject.map(({ project, analytics }) => {
      if (!analytics) {
        return { projectId: project.id, slug: project.slug, available: false as const };
      }
      totalRequests += analytics.traffic.totalRequests;
      totals["2xx"] += analytics.traffic.statusBreakdown["2xx"];
      totals["3xx"] += analytics.traffic.statusBreakdown["3xx"];
      totals["4xx"] += analytics.traffic.statusBreakdown["4xx"];
      totals["5xx"] += analytics.traffic.statusBreakdown["5xx"];
      totalCpuPercent += analytics.resourceUsage.current?.cpuPercent ?? 0;
      totalMemoryMb += analytics.resourceUsage.current?.memoryMb ?? 0;

      return {
        projectId: project.id,
        slug: project.slug,
        available: true as const,
        totalRequests: analytics.traffic.totalRequests,
        statusBreakdown: analytics.traffic.statusBreakdown,
        currentResourceUsage: analytics.resourceUsage.current,
      };
    });

    res.json({
      range,
      totalRequests,
      statusBreakdown: totals,
      resourceUsage: {
        totalCpuPercent: Math.round(totalCpuPercent * 100) / 100,
        totalMemoryMb: Math.round(totalMemoryMb * 100) / 100,
      },
      projects: perProjectSummary,
    });
  }
);
