import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { logAudit } from "../services/audit";
import { slugify } from "../lib/slug";
import { tearDownApp } from "../services/appTeardown";
import { fetchAppHealth } from "../services/appHealth";

export const projectsRouter = Router();
projectsRouter.use(requireProxyToken);

const createProjectSchema = z.object({ name: z.string().min(1) });

// slug is derived from name and immutable afterward — it's the
// subdomain/X-App-Name hostnsoft-deploy routes by. See docs/CLAUDE.md
// "Projects" on why slug and name are separate fields.
projectsRouter.post(
  "/companies/:companyId/projects",
  loadCompanyContext,
  async (req, res) => {
    const { name } = createProjectSchema.parse(req.body);
    const slug = slugify(name);
    if (!slug) {
      return res.status(400).json({ error: "Name must contain at least one letter or digit" });
    }

    const existing = await prisma.project.findUnique({ where: { slug } });
    if (existing) {
      return res.status(409).json({
        error: `Slug "${slug}" is already taken platform-wide — try a different name`,
      });
    }

    const project = await prisma.project.create({
      data: { companyId: req.company!.id, createdBy: req.userId!, slug, name },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: project.id,
      action: "project.create",
      details: slug,
    });
    res.status(201).json(project);
  }
);

projectsRouter.get("/companies/:companyId/projects", loadCompanyContext, async (req, res) => {
  const projects = await prisma.project.findMany({ where: { companyId: req.company!.id } });

  // status is the CURRENT deployment's own status (via currentDeploymentId
  // — see deployments.routes.ts's isCurrent for why this isn't just "most
  // recent by timestamp"), not a live health check — that stays GET-one
  // only (fetchAppHealth is a real Nomad call per app; doing that once
  // per project here would mean N network calls just to list them).
  // Batched as one extra query rather than N, regardless of how many
  // projects a company has.
  const currentDeploymentIds = projects
    .map((p) => p.currentDeploymentId)
    .filter((id): id is string => !!id);
  const currentDeployments = await prisma.deployment.findMany({
    where: { id: { in: currentDeploymentIds } },
    select: { id: true, status: true },
  });
  const statusById = new Map(currentDeployments.map((d) => [d.id, d.status]));

  res.json(
    projects.map((p) => ({
      ...p,
      status: (p.currentDeploymentId && statusById.get(p.currentDeploymentId)) || "no_deployments",
    }))
  );
});

projectsRouter.get(
  "/companies/:companyId/projects/:projectId",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const health = await fetchAppHealth(req.project!.slug);
    res.json({ ...req.project, health });
  }
);

const renameProjectSchema = z.object({ name: z.string().min(1) });

// Display name only — slug never changes after creation.
projectsRouter.patch(
  "/companies/:companyId/projects/:projectId",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const { name } = renameProjectSchema.parse(req.body);
    const project = await prisma.project.update({
      where: { id: req.project!.id },
      data: { name },
    });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: project.id,
      action: "project.rename",
      details: name,
    });
    res.json(project);
  }
);

const updateMemorySchema = z.object({ memoryMb: z.number().int().positive() });

projectsRouter.patch(
  "/companies/:companyId/projects/:projectId/memory",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const { memoryMb } = updateMemorySchema.parse(req.body);

    const project = await prisma.project.update({
      where: { id: req.project!.id },
      data: { memoryMb },
    });

    // TODO: push this into hostnsoft-deploy's Nomad job spec and trigger a
    // redeploy — this only persists the desired value here for now. See
    // docs/CLAUDE.md's "Required capabilities" integration note.
    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: project.id,
      action: "project.memory_change",
      details: `${memoryMb}MB`,
    });
    res.json(project);
  }
);

// Tears down the running app on hostnsoft-deploy (Nomad job + the
// Traefik routing that comes with it, plus any Docker image — see
// appTeardown.ts) before removing the DB row. Best-effort on the
// teardown call, same as orphan cleanup's use of the same helper: a
// hostnsoft-deploy outage must never block the project from actually
// being deletable, so a failed teardown is logged, not retried
// indefinitely or surfaced as a failure to the caller.
projectsRouter.delete(
  "/companies/:companyId/projects/:projectId",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    await tearDownApp(req.project!.slug);
    await prisma.project.delete({ where: { id: req.project!.id } });
    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: req.project!.id,
      action: "project.delete",
    });
    res.status(204).end();
  }
);
