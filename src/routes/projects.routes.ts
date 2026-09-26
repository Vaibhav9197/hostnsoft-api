import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { logAudit } from "../services/audit";
import { slugify } from "../lib/slug";
import { checkSlug } from "../lib/reservedSlugs";
import { startSlugChange, resolveSlugChangeStatus, SLUG_CHANGE_STATUS } from "../services/slugChangeFlow";
import { tearDownApp } from "../services/appTeardown";
import { fetchAppHealth } from "../services/appHealth";
import { resolveProjectStatus, resolveProjectStatuses, NO_DEPLOYMENTS_STATUS } from "../services/projectStatus";

export const projectsRouter = Router();
projectsRouter.use(requireProxyToken);

const createProjectSchema = z.object({ name: z.string().min(1) });

// slug is derived from name here — it's the subdomain/X-App-Name
// hostnsoft-deploy routes by. It is not immutable: it can be changed
// afterwards, deliberately and at some cost, via the slug endpoint
// below. See docs/CLAUDE.md "Projects" on why slug and name are
// separate fields.
projectsRouter.post(
  "/companies/:companyId/projects",
  loadCompanyContext,
  async (req, res) => {
    const { name } = createProjectSchema.parse(req.body);
    const slug = slugify(name);
    if (!slug) {
      return res.status(400).json({ error: "Name must contain at least one letter or digit" });
    }

    // Reserved/shape rules were previously enforced ONLY on the deploy
    // path (services/projectClaim.ts), so this route could mint an app
    // named `login` or `api` — a platform hostname — straight from the
    // dashboard. No grandfathering branch here: unlike a claim, this is
    // always a brand-new name, so there is no existing app to protect.
    const rejected = checkSlug(slug);
    if (rejected.reserved) {
      return res.status(409).json({ error: rejected.reason, code: rejected.code });
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

  // status: same shared helper as get-one below (projectStatus.ts),
  // batched as one extra DB query regardless of project count.
  //
  // health: a real Nomad call per app — genuinely more expensive than
  // status, but kept here too rather than silently different from
  // get-one's response shape (a resource's list and single views should
  // return the same fields; withholding one because it's costlier is a
  // per-endpoint decision that should be made explicitly, not fall out
  // by accident). Run in parallel across all of a company's projects
  // rather than sequentially — still N calls, just not N sequential
  // round trips. Revisit with pagination/an opt-out query param if a
  // company's project count ever makes this endpoint too slow in
  // practice; not a real problem at today's expected scale (a handful of
  // projects per company, not thousands).
  const [statusById, healthList] = await Promise.all([
    resolveProjectStatuses(projects),
    Promise.all(projects.map((p) => fetchAppHealth(p.slug))),
  ]);

  res.json(
    projects.map((p, i) => ({
      ...p,
      status: (p.currentDeploymentId && statusById.get(p.currentDeploymentId)) || NO_DEPLOYMENTS_STATUS,
      health: healthList[i],
    }))
  );
});

projectsRouter.get(
  "/companies/:companyId/projects/:projectId",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const [health, status] = await Promise.all([
      fetchAppHealth(req.project!.slug),
      resolveProjectStatus(req.project!.currentDeploymentId),
    ]);
    res.json({ ...req.project, status, health });
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

// Takes the slug literally rather than a display name to slugify: the
// caller is choosing a public web address, so a value that isn't usable
// has to come back as an error they can act on, not be silently mangled
// into something adjacent. (POST above still derives one from `name`,
// where the caller isn't picking an address at all.)
const changeSlugSchema = z.object({ slug: z.string().trim().min(1).max(63) });

// Changes the app's WEB ADDRESS — separate from the display-name rename
// above because this can be refused for reasons that one never can, and
// it is the caller's only warning that the old address dies.
//
// A live app answers 202 and migrates behind the response: it takes
// minutes (a fresh certificate among other things) and the dashboard
// proxy gives up at ten seconds. Poll the companion GET below. A
// never-deployed app is one UPDATE, so it answers 200, already finished.
//
// Agents reach the same flow at POST /apps/:appName/slug-change. The
// work is services/slugChangeFlow.ts, shared by both; what stays here is
// this surface's addressing and reply shape.
projectsRouter.patch(
  "/companies/:companyId/projects/:projectId/slug",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const { slug } = changeSlugSchema.parse(req.body);
    const project = req.project!;

    const started = await startSlugChange({
      project,
      requestedSlug: slug,
      companyId: req.company!.id,
      actorUserId: req.userId,
    });

    if (!started.ok) {
      return res.status(SLUG_CHANGE_STATUS[started.code]).json({ error: started.reason, code: started.code });
    }

    if (started.kind === "moving") {
      return res.status(202).json({
        moving: true,
        from: started.from,
        to: started.to,
        statusUrl: `/companies/${req.company!.id}/projects/${project.id}/slug`,
      });
    }

    // "unchanged" answers with the project as it already is; "applied"
    // with the updated row. Both are finished by the time we reply.
    res.json(started.project);
  }
);

// Where a live move reports its outcome, since the PATCH above cannot
// wait for one. Uses the same resolver the agent surface polls rather
// than the in-memory map: that map forgets a finished rename after 30
// minutes and on restart, which matters most here, where the caller is a
// person who may close the tab. The resolver falls back to the audit log.
//
// Always 200, carrying currentSlug. `state: "unknown"` replaces the old
// 404, which was indistinguishable from the project being gone.
projectsRouter.get(
  "/companies/:companyId/projects/:projectId/slug",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    res.json(await resolveSlugChangeStatus(req.project!));
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
