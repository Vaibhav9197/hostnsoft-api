import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { loadCompanyContext } from "../middleware/companyContext";
import { requireRole } from "../middleware/rbac";
import { logAudit } from "../services/audit";
import { slugify } from "../lib/slug";

export const projectsRouter = Router();
projectsRouter.use(requireAuth);

const createProjectSchema = z.object({ name: z.string().min(1) });

// slug is derived from name and immutable afterward — it's the
// subdomain/X-App-Name hostnsoft-deploy routes by. See docs/CLAUDE.md
// "Projects" on why slug and name are separate fields.
projectsRouter.post(
  "/companies/:companyId/projects",
  loadCompanyContext,
  requireRole("project_admin"),
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
      data: { companyId: req.company!.id, slug, name },
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
  res.json(projects);
});

projectsRouter.get(
  "/companies/:companyId/projects/:projectId",
  loadCompanyContext,
  async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, companyId: req.company!.id },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });

    // TODO: fetch live health from hostnsoft-deploy (Nomad allocation
    // status) once that integration point is designed — see
    // docs/CLAUDE.md "Required capabilities".
    res.json({ ...project, health: "unknown" });
  }
);

const renameProjectSchema = z.object({ name: z.string().min(1) });

// Display name only — slug never changes after creation.
projectsRouter.patch(
  "/companies/:companyId/projects/:projectId",
  loadCompanyContext,
  requireRole("project_admin"),
  async (req, res) => {
    const { name } = renameProjectSchema.parse(req.body);
    const project = await prisma.project.update({
      where: { id: req.params.projectId },
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
  requireRole("project_admin"),
  async (req, res) => {
    const { memoryMb } = updateMemorySchema.parse(req.body);

    const project = await prisma.project.update({
      where: { id: req.params.projectId },
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

// TODO: hostnsoft-deploy has no "stop/decommission an app" endpoint today
// (open question #7) — this deletes the DB row only. The Nomad job for
// this project's app keeps running, orphaned, until that endpoint exists.
// Flag this to whoever owns hostnsoft-deploy rather than silently
// accepting the orphaned-job risk.
projectsRouter.delete(
  "/companies/:companyId/projects/:projectId",
  loadCompanyContext,
  requireRole("project_admin"),
  async (req, res) => {
    await prisma.project.delete({ where: { id: req.params.projectId } });
    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: req.params.projectId,
      action: "project.delete",
    });
    res.status(204).end();
  }
);
