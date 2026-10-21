/**
 * Moving an app to another workspace (POST
 * /companies/:companyId/projects/:projectId/move, projects.routes.ts).
 *
 * A move changes which workspace OWNS the app and nothing about the app
 * itself: no rebuild, no redeploy, same address, same appId, same running
 * job. That works because almost everything an app has hangs off its
 * project id, not its workspace. Decided table by table (2026-10-21):
 *
 *   Project.companyId              moves — this is the move.
 *   AppDetails.companyId           moves — the showcase console lists an
 *                                  app's details by workspace, so they go
 *                                  with the app.
 *   Deployment, EnvVar, Domain,    follow on their own (keyed by projectId).
 *   Schedule(+Run), SlugAlias      Schedule.createdBy / Project.createdBy
 *                                  stay: they record who made them, and
 *                                  alerts still go to that person.
 *   ShowcaseEventListing           follows the app (via AppDetails). Listings
 *                                  already approved on another workspace's
 *                                  event stay approved.
 *   ShowcaseEvent.companyId        stays — an event page belongs to the
 *                                  workspace that organises it, not to any
 *                                  app listed on it.
 *   DeployToken.companyId          stays — tokens belong to a workspace (or a
 *                                  person), never to an app. The old
 *                                  workspace's tokens lose the app; they are
 *                                  told so (app_moved, services/tokenAccess.ts).
 *   AuditLog, FeatureRequest       stay — history of what happened where. The
 *                                  move itself is audited in BOTH workspaces.
 *   Company (plan, billing ids)    stays — it describes the workspace.
 *
 * Outside this database: hostnsoft-deploy keys nothing by workspace (jobs,
 * data, images and analytics are all by app name), so it needs no call —
 * except for one fact baked into the running job, the free-plan footer,
 * which is re-pushed (still no rebuild) when the two plans disagree. Billing
 * meters nothing per app today, so there is nothing to transfer there.
 */
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { isCompanyOnFreePlan } from "../lib/lago";
import { can } from "../lib/permissions";
import { getCompanyById } from "../lib/msg91";
import { logAudit } from "./audit";
import { isRenameInProgress } from "./renameStatus";
import { pushCustomDomainConfig } from "./customDomainActivation";
import { appLimitRefusal } from "./planLimits";
import { PROJECT_MOVE_ACTION } from "./tokenAccess";

export type MoveFailure =
  | "same_workspace"
  | "no_access"
  | "rename_in_progress"
  | "deploy_in_progress"
  | "plan_limit_reached"
  | "move_conflict";

export const MOVE_STATUS: Record<MoveFailure, number> = {
  same_workspace: 400,
  no_access: 403,
  rename_in_progress: 409,
  deploy_in_progress: 409,
  plan_limit_reached: 409,
  move_conflict: 409,
};

export type MoveResult =
  | { ok: true; project: Project; footerResync: boolean }
  | { ok: false; code: MoveFailure; reason: string };

export async function moveProject(input: {
  project: Project;
  targetCompanyId: string;
  actorUserId: string;
}): Promise<MoveResult> {
  const { project, targetCompanyId, actorUserId } = input;
  const fromCompanyId = project.companyId!;

  if (targetCompanyId === fromCompanyId) {
    return { ok: false, code: "same_workspace", reason: "This app is already in that workspace." };
  }

  // Both sides: taking the app out needs app.move where it is, putting it in
  // needs app.create where it goes — a move must not be a way to create apps
  // somewhere you couldn't create them directly. One message for both, and
  // no hint whether the target exists: from here, an id you aren't a member
  // of is the same as a made-up one.
  if (!(await can(actorUserId, fromCompanyId, "app.move", project.id))) {
    return { ok: false, code: "no_access", reason: "You don't have permission to move apps out of this workspace." };
  }
  if (!(await can(actorUserId, targetCompanyId, "app.create"))) {
    return {
      ok: false,
      code: "no_access",
      reason: "You can only move an app to a workspace where you can add apps.",
    };
  }

  // A rename moves the app's job and data under a new name across minutes;
  // a deploy writes a new version against the workspace it started in (its
  // record call is checked against that workspace's token). Either landing
  // halfway through a move ends with history in the wrong place, so a move
  // waits. Same in-flight test as an address change (projectSlugChange.ts).
  if (isRenameInProgress(project.id)) {
    return {
      ok: false,
      code: "rename_in_progress",
      reason: "This app's web address is being changed. Wait for that to finish, then move it.",
    };
  }
  const inFlight = await prisma.deployment.findFirst({
    where: { projectId: project.id, status: "in_progress" },
    select: { id: true },
  });
  if (inFlight) {
    return {
      ok: false,
      code: "deploy_in_progress",
      reason: "This app is being deployed right now. Wait for that to finish, then move it.",
    };
  }

  const limit = await appLimitRefusal(targetCompanyId, project);
  if (limit) return { ok: false, ...limit };

  // Compare-and-set on the source workspace, so two moves (or a move and a
  // delete) racing each other can't both win.
  const moved = await prisma.$transaction(async (tx) => {
    const updated = await tx.project.updateMany({
      where: { id: project.id, companyId: fromCompanyId },
      data: { companyId: targetCompanyId },
    });
    if (updated.count === 0) return null;
    await tx.appDetails.updateMany({ where: { projectId: project.id }, data: { companyId: targetCompanyId } });
    return tx.project.findUniqueOrThrow({ where: { id: project.id } });
  });
  if (!moved) {
    return {
      ok: false,
      code: "move_conflict",
      reason: "This app changed while you were moving it. Reload the page and try again.",
    };
  }

  // Both workspaces: the old one needs the row for its tokens to be told
  // the app moved (tokenAccess.ts wasMovedOutOf), the new one for "where did
  // this come from". Ids in details, names alongside for a person reading it.
  const [fromName, toName] = await Promise.all([
    getCompanyById(fromCompanyId).then((c) => c?.name ?? null).catch(() => null),
    getCompanyById(targetCompanyId).then((c) => c?.name ?? null).catch(() => null),
  ]);
  const details = JSON.stringify({ from: fromCompanyId, to: targetCompanyId, fromName, toName, slug: moved.slug });
  await Promise.all([
    logAudit({ actorUserId, companyId: fromCompanyId, projectId: moved.id, action: PROJECT_MOVE_ACTION, details }),
    logAudit({ actorUserId, companyId: targetCompanyId, projectId: moved.id, action: PROJECT_MOVE_ACTION, details }),
  ]);

  // The free-plan footer is decided per workspace and baked into the running
  // job, so moving between a free and a paid workspace would leave the
  // wrong one showing until the next deploy. Re-push the current version (no
  // rebuild) only when the plans disagree, and never fail the move over it:
  // the move is done, and the next deploy corrects the footer regardless.
  let footerResync = false;
  if (moved.currentDeploymentId) {
    const [wasFree, isFree] = await Promise.all([
      isCompanyOnFreePlan(fromCompanyId),
      isCompanyOnFreePlan(targetCompanyId),
    ]);
    if (wasFree !== isFree) {
      footerResync = true;
      void pushCustomDomainConfig(moved.id)
        .then((r) => {
          if (!r.pushed) logger.warn(`[projectMove] ${moved.slug}: footer re-push failed: ${r.error}`);
        })
        .catch((e) => logger.warn(`[projectMove] ${moved.slug}: footer re-push threw: ${(e as Error).message}`));
    }
  }

  return { ok: true, project: moved, footerResync };
}
