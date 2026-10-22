import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { refuseForStaticApp } from "../middleware/refuseForStaticApp";
import { logAudit } from "../services/audit";
import { slugify } from "../lib/slug";
import { checkSlug } from "../lib/reservedSlugs";
import { startSlugChange, resolveSlugChangeStatus, SLUG_CHANGE_STATUS } from "../services/slugChangeFlow";
import { tearDownApp } from "../services/appTeardown";
import { fetchAppHealth } from "../services/appHealth";
import { resolveProjectStatus, resolveProjectStatuses, NO_DEPLOYMENTS_STATUS } from "../services/projectStatus";
import { applyCurrentConfig } from "../services/redeploy";
import { claimCodeMatches } from "../lib/orphanClaim";
import { unexpiredOrphanWhere } from "../services/projectClaim";
import { logger } from "../lib/logger";
import { scheduleSummaries, scheduleSummary } from "../services/schedules";
import { MOVE_STATUS, moveProject } from "../services/projectMove";

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

const claimOrphanSchema = z.object({
  appName: z.string().min(1).regex(/^[a-z0-9-]+$/),
  code: z.string().min(1).max(200),
});

// Keep an anonymous app by signing in — the claim-link path, see
// docs/Anonymous-deploy-req.md ("Claim link", 2026-10-08). The deploy that
// created the orphan handed back a link to the dashboard's /claim page
// carrying the app name and a one-time code (lib/orphanClaim.ts); that
// page signs the person in, has them pick (or create) a company, and
// calls this. The code is the proof of ownership — an orphan stores no
// owner, so without it anyone who knew the name could take the app.
//
// Redeploying the same name with a deploy token (services/projectClaim.ts's
// adopt branch) still claims too, and stays the fallback for a lost link.
//
// Wrong code, unknown name, expired, already claimed: all the same 404, on
// purpose. Telling them apart would let someone holding only a name learn
// whether an app exists and whether it is still up for grabs.
projectsRouter.post(
  "/companies/:companyId/orphans/claim",
  loadCompanyContext,
  async (req, res) => {
    const { appName, code } = claimOrphanSchema.parse(req.body);

    const notFound = () =>
      res.status(404).json({
        error:
          "This link doesn't match a temporary app. It may have been claimed already, or its 24 hours may have run out.",
        code: "claim_not_found",
      });

    const candidate = await prisma.project.findUnique({ where: { slug: appName } });
    if (
      !candidate ||
      !candidate.isOrphan ||
      (candidate.orphanExpiresAt !== null && candidate.orphanExpiresAt.getTime() <= Date.now()) ||
      !claimCodeMatches(code, candidate.claimCodeHash)
    ) {
      return notFound();
    }

    // isOrphan in the where, not just the id: two people opening the same
    // link at once (or a token redeploy landing in the same instant) must
    // end with exactly one claimant. Whoever's update matches zero rows
    // lost, and sees the same 404 as a stale link. The expiry is in the
    // where too, so an app that expires between the check above and this
    // write can't be claimed out from under orphan cleanup — see
    // unexpiredOrphanWhere.
    const moved = await prisma.project.updateMany({
      where: { id: candidate.id, ...unexpiredOrphanWhere() },
      data: {
        companyId: req.company!.id,
        createdBy: req.userId!,
        isOrphan: false,
        orphanExpiresAt: null,
        claimCodeHash: null,
      },
    });
    if (moved.count === 0) return notFound();
    const project = await prisma.project.findUniqueOrThrow({ where: { id: candidate.id } });

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: project.id,
      action: "project.claim",
      details: `${project.slug} (claim link)`,
    });

    // The app is claimed from here on whatever happens below — the
    // deletion is cancelled and it is in the dashboard. What's left is
    // the orphan banner, which hostnsoft-deploy's config push rebuilds
    // the running image's job spec without (no rebuild, no source). That
    // needs the current image's tag, which the anonymous deploy recorded
    // (internalDeployments.routes.ts); an orphan from before that was
    // recorded, or whose record call failed, has nothing to re-push, so
    // the banner stays until the next deploy. Said in the reply rather
    // than failing the claim: losing the app over a missing history row
    // would be far worse than a stale banner.
    const outcome = await applyCurrentConfig(project, {
      triggeredBy: req.userId!,
      source: "dashboard",
      agentName: null,
    });
    if (!outcome.ok) {
      logger.warn(
        `[orphanClaim] "${project.slug}" claimed by ${req.userId} but the banner could not be cleared now (${outcome.code}); it clears on the next deploy`
      );
    }

    const [health, status, schedules] = await Promise.all([
      fetchAppHealth(project.slug),
      resolveProjectStatus(project.currentDeploymentId),
      scheduleSummary(project.id),
    ]);
    res.json({
      project: { ...project, status, health, schedules },
      // Whether the no-rebuild re-push without the banner was started.
      applied: outcome.ok,
      deploymentId: outcome.ok ? outcome.deployment.id : null,
      bannerClearsOn: outcome.ok ? "now" : "next_deploy",
    });
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
  // schedules: {count, failing} — one grouped query for every project, so
  // the app cards can show "Needs attention" for a failing scheduled job.
  const [statusById, healthList, scheduleById] = await Promise.all([
    resolveProjectStatuses(projects),
    Promise.all(projects.map((p) => fetchAppHealth(p.slug))),
    scheduleSummaries(projects.map((p) => p.id)),
  ]);

  res.json(
    projects.map((p, i) => ({
      ...p,
      status: (p.currentDeploymentId && statusById.get(p.currentDeploymentId)) || NO_DEPLOYMENTS_STATUS,
      health: healthList[i],
      schedules: scheduleById.get(p.id)!,
    }))
  );
});

projectsRouter.get(
  "/companies/:companyId/projects/:projectId",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const [health, status, schedules] = await Promise.all([
      fetchAppHealth(req.project!.slug),
      resolveProjectStatus(req.project!.currentDeploymentId),
      scheduleSummary(req.project!.id),
    ]);
    res.json({ ...req.project, status, health, schedules });
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

const moveProjectSchema = z.object({ targetCompanyId: z.string().trim().min(1) });

// Moves the app to another workspace the caller is in — ownership only: same
// address, same appId, same running version, no redeploy. Everything that
// follows (and what doesn't) is listed in services/projectMove.ts.
//
// The caller needs app.move here and app.create in the target, checked with
// can(). loadCompanyContext already established they are a member here; the
// target is checked inside the service, not by URL, since the app isn't
// there yet.
//
// Afterwards this workspace's deploy tokens no longer reach the app and get
// 409 app_moved when they try (never a copy); personal tokens of anyone who
// can deploy in the target keep working, with a one-time app_moved notice.
//
// Codes: 400 same_workspace; 403 no_access; 409 rename_in_progress /
// deploy_in_progress / plan_limit_reached / move_conflict.
projectsRouter.post(
  "/companies/:companyId/projects/:projectId/move",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const { targetCompanyId } = moveProjectSchema.parse(req.body);
    const result = await moveProject({ project: req.project!, targetCompanyId, actorUserId: req.userId! });
    if (!result.ok) {
      return res.status(MOVE_STATUS[result.code]).json({ error: result.reason, code: result.code });
    }

    // The project in exactly GET-one's shape, so the dashboard can render it
    // under its new workspace without a second fetch.
    const [health, status, schedules] = await Promise.all([
      fetchAppHealth(result.project.slug),
      resolveProjectStatus(result.project.currentDeploymentId),
      scheduleSummary(result.project.id),
    ]);
    res.json({
      project: { ...result.project, status, health, schedules },
      from: req.company!.id,
      to: targetCompanyId,
      // Whether the free-plan footer is being re-applied because the two
      // workspaces are on different plans (no rebuild either way).
      footerResync: result.footerResync,
    });
  }
);

const updateMemorySchema = z.object({ memoryMb: z.number().int().positive() });

projectsRouter.patch(
  "/companies/:companyId/projects/:projectId/memory",
  loadCompanyContext,
  loadProjectContext,
  refuseForStaticApp("memory"),
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
