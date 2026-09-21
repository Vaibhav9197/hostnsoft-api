import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { logAudit } from "../services/audit";
import { slugify } from "../lib/slug";
import { checkSlug } from "../lib/reservedSlugs";
import { startSlugChange, SLUG_CHANGE_STATUS } from "../services/slugChangeFlow";
import { getRenameStatus } from "../services/renameStatus";
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

// Changes the app's WEB ADDRESS — a different thing from the rename
// above, and deliberately a different endpoint: this one can be refused
// for reasons the display-name rename never can, and it is the caller's
// only warning that the old address dies.
//
// An agent can do this too, with its deploy token, at
// POST /apps/:appName/slug-change (routes/agentApps.routes.ts). This
// used to be dashboard-only, on the grounds that a company-wide token
// meant one agent could strand every other agent and CI job holding the
// old name. That reasoning didn't survive examination: it describes the
// slug, not the caller — a person clicking rename here strands them just
// as completely, and is the party least likely to know who holds it.
// What makes it safe on both surfaces is that stranding is no longer
// terminal: a caller arriving on the old name is told the new one
// (`app_renamed`, middleware/deployTokenContext.ts), and the cooldown
// bounds how often anyone can move an app at all.
//
// For an app that has already deployed this is SLOW: a real migration on
// hostnsoft-deploy, including a fresh certificate order for the new
// hostname. Nothing in front of this service will hold a request that
// long — the dashboard's own proxy gives up after ten seconds — so a
// live move answers 202 straight away and continues behind the response.
// Poll the companion GET below for the outcome. An app that has never
// deployed still answers 200 with the updated project, because that
// really is finished by then.
//
// The work itself is services/slugChangeFlow.ts, shared with the agent
// route; what stays here is this surface's addressing and reply shape.
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
// wait for one. 404 when nothing is known: either no move was started or
// it finished long enough ago to have been forgotten, and the project's
// own slug is the answer in both cases.
projectsRouter.get(
  "/companies/:companyId/projects/:projectId/slug",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const status = getRenameStatus(req.project!.id);
    if (!status) {
      return res.status(404).json({ error: "No address change is in progress for this app.", code: "no_rename" });
    }
    res.json(status);
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
