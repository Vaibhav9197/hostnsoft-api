import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { resolveDeployTarget, claimOrphanProject } from "../services/projectClaim";
import {
  accessActorOfDeploy,
  actorPersonId,
  deployCreatedBy,
  deployCredentialFields,
  resolveDeployActor,
} from "../services/deployActor";
import { isRenameInProgress, isRenameTargeting } from "../services/renameStatus";
import { buildOrphanMessage, buildTokenSteps, ORPHAN_LOGIN_URL } from "../lib/orphanMessage";
import { isCompanyOnFreePlan } from "../lib/lago";
import { buildClaimUrl } from "../lib/orphanClaim";
import { ScheduleValidationError, validateDeclaredSchedules } from "../services/schedules";
import { ensureCronSecret } from "../services/scheduleSync";
import { SCHEDULE_MAX_PER_APP } from "../lib/scheduleConfig";

export const internalProjectsRouter = Router();

// Every credential field is optional — see services/deployActor.ts for
// which combination selects which path. ALL of them absent means "deploy
// anonymously" (docs/Anonymous-deploy-req.md); hostnsoft-deploy only
// omits them when the incoming deploy request itself carried no
// credential header at all (an invalid/malformed token it still sends
// here so this endpoint's normal 401 applies — anonymous is opt-in by
// omission only, never a fallback for a failed auth attempt).
const claimSchema = z.object({
  ...deployCredentialFields,
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  // Optional: the app's stable id, from X-App-Id (the deployer keeps it in
  // embarko.json after the first deploy). When present it decides the app
  // and `slug` is only what the deployer believes it is called — see
  // services/projectClaim.ts resolveDeployTarget.
  appId: z.string().trim().min(1).max(64).regex(/^[a-z0-9]+$/).optional(),
  // Optional — see schema.prisma's Project.appType. hostnsoft-deploy has
  // already validated the X-App-Type header it came from; re-checked here
  // so nothing longer or stranger can reach the column another way.
  appType: z.string().trim().min(1).max(60).optional(),
  // The `schedules` list from the app's embarko.json, read from the upload
  // by hostnsoft-deploy (its embarko-config.js) but not otherwise checked —
  // validated here, before any build, so a bad one refuses the deploy at
  // once. Applied only when the deploy succeeds
  // (internalDeployments.routes.ts). Absent = leave the app's schedules alone.
  schedules: z.unknown().optional(),
});

// Called by hostnsoft-deploy BEFORE it spends any build/Nomad resources
// on a deploy — this is what actually enforces "app name (== live
// subdomain) must be unique platform-wide" at the only point that
// matters: before the Nomad job (named by that same app name) gets
// created, not after. Which company the project gets created under comes
// from the caller's credential, never from the request's own say-so: the
// deploy token's own companyId, or (added 2026-09-17, for the dashboard's
// upload UI) the companyId a proxy_auth_token was just confirmed a member
// of — see services/deployActor.ts. A project never needs to exist via
// the dashboard first; this is the auto-create path for CLI/skill-first
// usage. No requireProxyToken — the credential in the body is the
// credential, same trust shape as the other /internal/* endpoints.
internalProjectsRouter.post("/internal/projects/claim", async (req, res) => {
  const { slug, appId, appType, schedules: rawSchedules, ...credentials } = claimSchema.parse(req.body);

  // Checked before the credential: a malformed list is the caller's mistake
  // whoever they are, and costs nothing to report.
  let declared: ReturnType<typeof validateDeclaredSchedules> | undefined;
  if (rawSchedules !== undefined) {
    try {
      declared = validateDeclaredSchedules(rawSchedules, SCHEDULE_MAX_PER_APP);
    } catch (e) {
      if (e instanceof ScheduleValidationError) return res.status(400).json({ error: e.message, code: e.code });
      throw e;
    }
  }

  const resolved = await resolveDeployActor(req, credentials);
  if (!resolved.ok) {
    return res.status(resolved.status).json(resolved.body);
  }

  // Refuse a deploy that would collide with a running address change.
  // Two collisions, neither caught by the claim's uniqueness check:
  // deploying under the app's CURRENT name builds a job the migration is
  // tearing down; deploying under the name it is moving TO creates a
  // SECOND project, since no project holds that name until the migration
  // succeeds — which then fails the unique constraint as rename_desynced.
  //
  // The other half of the interlock in projectSlugChange.ts, here because
  // it refuses before any build resources are spent. Orphans are exempt:
  // no company, so nothing of theirs can be mid-rename.
  if (resolved.actor.companyId) {
    const existing = await prisma.project.findFirst({
      where: { slug, companyId: resolved.actor.companyId },
      select: { id: true },
    });
    if (
      (existing && isRenameInProgress(existing.id)) ||
      (appId && isRenameInProgress(appId)) ||
      isRenameTargeting(resolved.actor.companyId, slug)
    ) {
      return res.status(409).json({
        error:
          `The app "${slug}" is having its web address changed right now. ` +
          `Wait for that to finish, then deploy again — check the name first, it may have moved.`,
        code: "rename_in_progress",
      });
    }
  }

  // A company-identified caller claims/adopts under that company; an
  // anonymous one gets the orphan path, byte for byte as before. Which
  // credential proved the company (a deploy token or a dashboard PAT)
  // makes no difference from here on — a project claimed through the
  // upload UI is an ordinary project of that company, with no record of
  // how it was first deployed. An anonymous caller can't rename an app,
  // so its appId (if any) has nothing to add and is ignored.
  const access = accessActorOfDeploy(resolved.actor);
  const claim = resolved.actor.companyId && access
    ? await resolveDeployTarget(resolved.actor.companyId, slug, appId, deployCreatedBy(resolved.actor), access)
    : await claimOrphanProject(slug);

  // Reserved before taken: a name that's both should say it's reserved,
  // since that's the one the caller can't resolve by trying again later.
  if (claim.rejected) {
    return res.status(claim.rejected.status ?? 409).json({
      error: claim.rejected.reason,
      code: claim.rejected.code,
    });
  }

  if (claim.conflict) {
    return res.status(409).json({
      error: `App name "${slug}" is already in use by a different workspace`,
      code: "app_name_taken",
    });
  }

  // The check above only looks in the caller's own workspace, which is
  // every app a workspace token can reach — but a user token can land on an
  // app in another workspace (services/tokenAccess.ts), and that app can be
  // mid-rename too. Safe to ask only now: resolving an existing app writes
  // nothing, and an app this claim just created or adopted can't be moving.
  if (isRenameInProgress(claim.project.id)) {
    return res.status(409).json({
      error:
        `The app "${claim.project.slug}" is having its web address changed right now. ` +
        `Wait for that to finish, then deploy again — check the name first, it may have moved.`,
      code: "rename_in_progress",
    });
  }

  // Recorded here rather than on a successful deploy: it describes what
  // the app is meant to be, which a failed build doesn't change. Only set
  // when sent, so a redeploy without the header keeps the earlier value.
  const project =
    appType && appType !== claim.project.appType
      ? await prisma.project.update({ where: { id: claim.project.id }, data: { appType } })
      : claim.project;

  // Include this project's already-active custom domains (see
  // docs/Customdomain-req.md) so every fresh deploy/rebuild regenerates
  // the job spec with their routers too — without this, a redeploy after
  // a custom domain was already active would silently drop it, since
  // hostnsoft-deploy has no persistent state of its own to remember it
  // by. This is the same call hostnsoft-deploy already makes on every
  // deploy, so no new integration point is needed for this to work.
  const activeDomains = await prisma.domain.findMany({
    where: { projectId: project.id, status: "active" },
    select: { domain: true },
  });

  // This project's configured env vars (see envVars.routes.ts) — sent on
  // every deploy so hostnsoft-deploy can bake them into the container's
  // env block. Previously set here but never actually reached the
  // running app (see docs/CLAUDE.md's known gaps); this is that missing
  // integration point. An orphan project can never have any (env vars
  // are only ever set through the company-scoped route, which requires
  // an already-claimed project), so this naturally comes back empty for
  // anonymous deploys without any special-casing.
  // Schedules need an owner (alerts go to them) and a deploy token to manage
  // them, so a temporary app's are not taken. The deploy itself goes ahead;
  // the reply says why its schedules were not.
  let schedulesClaim: { declared: number; accepted: boolean; reason?: string } | undefined;
  if (declared) {
    if (project.isOrphan || !resolved.actor.companyId) {
      schedulesClaim = {
        declared: declared.length,
        accepted: false,
        reason: "Schedules need a kept app. Get a deploy token, then deploy again with the same embarko.json.",
      };
    } else {
      // Before the env read below, so a new secret is in this deploy's env.
      if (declared.length > 0) await ensureCronSecret(project.id, actorPersonId(resolved.actor) ?? project.createdBy ?? "system");
      schedulesClaim = { declared: declared.length, accepted: true };
    }
  }

  // Lets the deploy reply say "kept as they are" when this upload declares
  // none but the app has some — see docs/schedules.md "Declared on deploy".
  const scheduleCount = await prisma.schedule.count({ where: { projectId: project.id } });

  const envVars = await prisma.envVar.findMany({
    where: { projectId: project.id },
    select: { key: true, value: true },
  });

  // Free-plan flag for hostnsoft-deploy's footer.
  const isFreePlan = await isCompanyOnFreePlan(project.companyId);

  // Only the deploy that created the orphan carries a code (see
  // claimOrphanProject) — so only that one response has a link, and the
  // link is the one copy of the code that ever leaves this service.
  const claimUrl = claim.claimCode ? buildClaimUrl(project.slug, claim.claimCode) : null;

  res.json({
    projectId: project.id,
    // The app's CURRENT name, which hostnsoft-deploy builds and routes
    // under — not necessarily the slug it sent (see resolveDeployTarget).
    slug: project.slug,
    // "created" only when this claim made the project (a fresh orphan
    // included), so the deploy reply can say a new app was made.
    action: claim.created || claim.claimCode ? "created" : "updated",
    notices: claim.notices ?? [],
    isFreePlan,
    memoryMb: project.memoryMb,
    customDomains: activeDomains.map((d) => d.domain),
    envVars,
    scheduleCount,
    ...(schedulesClaim ? { schedules: schedulesClaim } : {}),
    // Orphan fields — see docs/Anonymous-deploy-req.md. isOrphan is
    // always present; the other two are only meaningful (and only sent)
    // when it's true, so hostnsoft-deploy can check one field to decide
    // whether to inject the banner and include `orphan` in its response.
    isOrphan: project.isOrphan,
    // This deploy is the one that claimed a previously anonymous app, so
    // hostnsoft-deploy can tell the agent it is permanent now.
    claimedNow: claim.adopted === true,
    ...(project.isOrphan && project.orphanExpiresAt
      ? {
        orphanExpiresAt: project.orphanExpiresAt.toISOString(),
        orphanMessage: buildOrphanMessage(project.orphanExpiresAt, claimUrl),
        orphanLoginUrl: ORPHAN_LOGIN_URL,
        howToGetToken: buildTokenSteps(),
        // The keep-this-app link for the deployer — first deploy only.
        // hostnsoft-deploy relays it as links.claim; the status/lookup
        // replies never carry it, since they need no credential.
        ...(claimUrl ? { claimUrl } : {}),
      }
      : {}),
  });
});

const lookupSchema = z.object({ slug: z.string().min(1).regex(/^[a-z0-9-]+$/) });

// Read-only — unlike POST .../claim above, this never creates or adopts
// a project. Backs hostnsoft-deploy's GET /apps/:appName/status and
// .../logs, which need to know "does this app exist, is it orphan, and
// which company owns it" to authorize the request, WITHOUT the side
// effect claiming would have (silently adopting an orphan into the
// caller's company, or creating a phantom project row for a
// never-deployed/mistyped app name, just from checking its status).
internalProjectsRouter.post("/internal/projects/lookup", async (req, res) => {
  const { slug } = lookupSchema.parse(req.body);
  const project = await prisma.project.findUnique({ where: { slug } });
  if (!project) {
    return res.json({ exists: false });
  }
  res.json({
    exists: true,
    companyId: project.companyId,
    isOrphan: project.isOrphan,
    // The deadline hostnsoft-deploy's status reply relays to the agent.
    orphanExpiresAt: project.isOrphan && project.orphanExpiresAt ? project.orphanExpiresAt.toISOString() : null,
  });
});
