import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { logAudit } from "../services/audit";
import { slugify } from "../lib/slug";
import { checkSlug } from "../lib/reservedSlugs";
import { changeProjectSlug, type SlugChangeFailure } from "../services/projectSlugChange";
import { tearDownApp } from "../services/appTeardown";
import { fetchAppHealth } from "../services/appHealth";
import { resolveProjectStatus, resolveProjectStatuses, NO_DEPLOYMENTS_STATUS } from "../services/projectStatus";

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

// Which failures are the caller's malformed input vs. a genuine conflict
// with platform state. Reserved names sit with the conflicts, matching
// how POST /internal/projects/claim already reports them.
const SLUG_CHANGE_STATUS: Record<SlugChangeFailure, number> = {
  invalid_app_name: 400,
  app_name_too_short: 400,
  app_name_too_long: 400,
  app_name_reserved: 409,
  app_name_taken: 409,
  deploy_in_progress: 409,
  no_current_deployment: 409,
  slug_change_cooldown: 429,
  app_state_unknown: 503,
  // The move was attempted and did not happen; the app is untouched and
  // still on its old address. 502 because the failure is downstream.
  rename_failed: 502,
  // The move DID happen and we couldn't record it. 500: this one is
  // ours, and it needs a person, not a retry.
  rename_desynced: 500,
};

// Changes the app's WEB ADDRESS — a different thing from the rename
// above, and deliberately a different endpoint: this one can be refused
// for reasons the display-name rename never can, and it is the caller's
// only warning that the old address dies. Dashboard-only on purpose
// (no agent-facing equivalent on /apps/:appName): deploy tokens are
// company-wide, so letting one agent move an app would strand every
// other agent and CI job still holding the old name.
//
// For an app that has already deployed this is SLOW: it holds the
// request for a real migration on hostnsoft-deploy, including a fresh
// certificate order for the new hostname, so minutes rather than
// milliseconds. Callers must not assume a quick answer. See
// services/projectSlugChange.ts.
projectsRouter.patch(
  "/companies/:companyId/projects/:projectId/slug",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const { slug } = changeSlugSchema.parse(req.body);
    const outcome = await changeProjectSlug(req.project!, slug);

    if (!outcome.ok) {
      return res.status(SLUG_CHANGE_STATUS[outcome.code]).json({ error: outcome.reason, code: outcome.code });
    }

    // Re-submitting the address it already has changes nothing, so it
    // gets no audit row — an audit log should record what happened, and
    // nothing did.
    if (!outcome.unchanged) {
      await logAudit({
        actorUserId: req.userId,
        companyId: req.company!.id,
        projectId: outcome.project.id,
        action: "project.slug_change",
        details: `${outcome.previousSlug} -> ${outcome.project.slug}`,
      });
    }

    res.json(outcome.project);
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
