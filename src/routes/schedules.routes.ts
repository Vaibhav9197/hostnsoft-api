/**
 * Schedules for the dashboard: read-only. A person sees each scheduled
 * job, when it runs next and whether its last run worked; changing them is
 * the AI's job (embarko.json, or the agent API in agentApps.routes.ts), per
 * the panel's rule that it shows state and pushes work back to the AI.
 * Same Schedule and Run shapes as the agent API (services/schedules.ts).
 */
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { LAST_RUN, listRuns, runsQuerySchema, toScheduleResponse } from "../services/schedules";
import { SCHEDULE_MAX_PER_APP } from "../lib/scheduleConfig";

export const schedulesRouter = Router();
schedulesRouter.use(requireProxyToken);

schedulesRouter.get(
  "/companies/:companyId/projects/:projectId/schedules",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const schedules = await prisma.schedule.findMany({
      where: { projectId: req.project!.id },
      orderBy: { createdAt: "asc" },
      include: LAST_RUN,
    });
    res.json({
      schedules: schedules.map((s) => toScheduleResponse(s, req.project!.slug)),
      limit: SCHEDULE_MAX_PER_APP,
    });
  }
);

// ?limit, ?page, ?outcome=ok|failed|skipped|running, ?trigger=schedule|manual
schedulesRouter.get(
  "/companies/:companyId/projects/:projectId/schedules/:scheduleId/runs",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const query = runsQuerySchema.parse(req.query);
    const schedule = await prisma.schedule.findFirst({
      where: { id: req.params.scheduleId, projectId: req.project!.id },
      select: { id: true },
    });
    if (!schedule) return res.status(404).json({ error: "Schedule not found", code: "schedule_not_found" });
    res.json(await listRuns(schedule.id, query));
  }
);
