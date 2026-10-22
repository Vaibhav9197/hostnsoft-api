/**
 * Running an address change end to end, for whichever surface asked for
 * it.
 *
 * services/projectSlugChange.ts owns the policy (what a name may be,
 * which path an app needs) and the mechanics (the UPDATE, or the
 * migration). What it knows nothing about lives here: the in-progress
 * interlock, the audit row the cooldown reads, and the start/finish
 * bookkeeping a poller reads — the parts a second caller must not
 * re-implement. Both routes call startSlugChange and then decide only how
 * to spell the answer.
 */
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { logAudit } from "./audit";
import { platformAppUrl } from "./showcase";
import {
  prepareSlugChange,
  applyDatabaseOnlySlugChange,
  runSlugMigration,
  slugChangeDetails,
  parseSlugChangeDetails,
  SLUG_CHANGE_AUDIT_ACTION,
  SLUG_CHANGE_LIVE_AUDIT_ACTION,
  SLUG_CHANGE_AUDIT_ACTIONS,
  type SlugChangeFailure,
} from "./projectSlugChange";
import {
  markRenameStarted,
  markRenameFinished,
  getRenameStatus,
  isRenameInProgress,
  findRenameFrom,
} from "./renameStatus";

/**
 * Everything a caller can be refused for. `rename_in_progress` was
 * route-resident before this module existed; it belongs with the rest so
 * that a second surface cannot forget it.
 */
export type SlugChangeRefusal = SlugChangeFailure | "rename_in_progress";

export type SlugChangeStart =
  | { ok: true; kind: "unchanged"; project: Project }
  | { ok: true; kind: "applied"; project: Project; previousSlug: string }
  | { ok: true; kind: "moving"; project: Project; from: string; to: string }
  | { ok: false; code: SlugChangeRefusal; reason: string };

/**
 * Which refusals are malformed input and which are a conflict with
 * platform state.
 *
 * Shared by both routes, bending redeploy.ts's "only routes choose status
 * codes" rule on purpose: that rule already let one code mean two things
 * on two surfaces (`no_current_deployment` is 409 here, 422 on redeploy).
 * The routes keep what is audience-specific — the prose and extra fields.
 */
export const SLUG_CHANGE_STATUS: Record<SlugChangeRefusal, number> = {
  invalid_app_name: 400,
  app_name_too_short: 400,
  app_name_too_long: 400,
  app_name_reserved: 409,
  app_name_taken: 409,
  deploy_in_progress: 409,
  no_current_deployment: 409,
  rename_in_progress: 409,
  slug_change_cooldown: 429,
  app_state_unknown: 503,
  // The move was attempted and did not happen; the app is untouched and
  // still on its old address. 502 because the failure is downstream.
  rename_failed: 502,
  // The move DID happen and we couldn't record it. 500: this one is
  // ours, and it needs a person, not a retry.
  rename_desynced: 500,
};

/**
 * Validate, decide which path the app needs, and start it.
 *
 * Returns as soon as the outcome is KNOWN, which for a live app is
 * before the work is done: the migration takes minutes and nothing in
 * front of this service will hold a request that long. `kind: "moving"`
 * means it is running behind the response — read the result with
 * resolveSlugChangeStatus.
 */
export async function startSlugChange(input: {
  project: Project;
  requestedSlug: string;
  companyId: string;
  actorUserId?: string;
  /**
   * Appended to the audit detail, e.g. "agent:<token label>". The
   * caller supplies only the note, never the whole string — the format
   * has one owner (projectSlugChange.ts) and this is how it stays that
   * way.
   */
  actorNote?: string;
}): Promise<SlugChangeStart> {
  const { project, requestedSlug, companyId, actorUserId, actorNote } = input;

  // First, and before any work: a second change while one is running
  // would stop a Nomad job the first is still moving. Here rather than
  // in the routes because it is also the idempotency backstop for a
  // caller that retried a dropped 202 — a machine will, and a route that
  // forgot this check would migrate twice.
  if (isRenameInProgress(project.id)) {
    return {
      ok: false,
      code: "rename_in_progress",
      reason: "This app's address is already being changed. Wait for that to finish.",
    };
  }

  const plan = await prepareSlugChange(project, requestedSlug);
  if (!plan.ok) return { ok: false, code: plan.code, reason: plan.reason };

  // The action records which path moved it: only the live one is charged
  // for by the cooldown. See projectSlugChange.ts.
  const audit = (action: string, previousSlug: string, nextSlug: string) =>
    logAudit({
      actorUserId,
      companyId,
      projectId: project.id,
      action,
      details: slugChangeDetails(previousSlug, nextSlug, actorNote),
    });

  // Re-submitting the address it already has changes nothing, so no
  // audit row — an audit log should record what happened, and nothing
  // did. (It also must not start a cooldown.)
  if (plan.unchanged) return { ok: true, kind: "unchanged", project };

  if (!plan.live) {
    const outcome = await applyDatabaseOnlySlugChange(project, plan.slug);
    if (!outcome.ok) return { ok: false, code: outcome.code, reason: outcome.reason };
    await audit(SLUG_CHANGE_AUDIT_ACTION, outcome.previousSlug, outcome.project.slug);
    return { ok: true, kind: "applied", project: outcome.project, previousSlug: outcome.previousSlug };
  }

  const from = project.slug;
  const to = plan.slug;

  // Marked and launched BEFORE returning, so there is no window in which
  // a concurrent request sees no rename in progress.
  markRenameStarted(project.id, companyId, from, to);

  // Intentionally not awaited. Never throws outward: by the time this
  // runs the caller has its answer, so every outcome is recorded for the
  // poller instead.
  //
  // `project` here is the row as it was read, which is what
  // runSlugMigration wants — it reads only id, slug and
  // currentDeploymentId, all still correct, and the slug it needs is
  // deliberately the OLD one.
  void (async () => {
    try {
      const outcome = await runSlugMigration(project, to);

      // Before the audit write, and the audit write kept off the failure
      // path below: the slug is already written by now, so a blip while
      // logging must not tell the poller the app is still on its old name.
      markRenameFinished(
        project.id,
        outcome.ok ? { ok: true } : { ok: false, code: outcome.code, reason: outcome.reason }
      );

      if (outcome.ok) {
        try {
          await audit(SLUG_CHANGE_LIVE_AUDIT_ACTION, outcome.previousSlug, outcome.project.slug);
        } catch (e) {
          // Loud: the cooldown and the "where did this app go" lookup
          // both read this row, and are blind to a rename without it.
          logger.error(
            `[slugChangeFlow] project ${project.id} moved "${outcome.previousSlug}" -> ` +
              `"${outcome.project.slug}" but the audit row failed to write: ${(e as Error).message}`
          );
        }
      }
    } catch (e) {
      const reason = (e as Error).message;
      logger.error(`[slugChangeFlow] migration for ${project.id} threw: ${reason}`);
      markRenameFinished(project.id, { ok: false, code: "rename_failed", reason });
    }
  })();

  return { ok: true, kind: "moving", project, from, to };
}

export type SlugChangeView =
  | { state: "in_progress"; from: string; to: string; startedAt: string; currentSlug: string; appUrl: string }
  | {
      state: "succeeded";
      from: string;
      to: string;
      startedAt?: string;
      finishedAt?: string;
      currentSlug: string;
      appUrl: string;
    }
  | {
      state: "failed";
      from: string;
      to: string;
      startedAt: string;
      finishedAt: string;
      code: string;
      reason: string;
      currentSlug: string;
      appUrl: string;
    }
  | { state: "unknown"; currentSlug: string; appUrl: string };

/**
 * How an address change ended, for a caller that wasn't held on the
 * line for it.
 *
 * Two sources: renameStatus while this process lives, then the audit log,
 * where a row targeting the app's CURRENT slug means the move happened —
 * true across a restart and on an instance that didn't run the migration.
 * That fallback doesn't contradict renameStatus.ts's case against
 * persistence: that is about in-progress state, this only about finished.
 *
 * Every state carries currentSlug, so a caller never has to infer where
 * the app is from an HTTP status.
 */
export async function resolveSlugChangeStatus(project: Project): Promise<SlugChangeView> {
  const where = { currentSlug: project.slug, appUrl: platformAppUrl(project.slug) };

  const live = getRenameStatus(project.id);
  if (live) return { ...live, ...where };

  const last = await prisma.auditLog.findFirst({
    where: { projectId: project.id, action: { in: [...SLUG_CHANGE_AUDIT_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    select: { details: true, createdAt: true },
  });

  const pair = parseSlugChangeDetails(last?.details ?? null);
  if (pair && pair.to === project.slug) {
    return { state: "succeeded", ...pair, finishedAt: last!.createdAt.toISOString(), ...where };
  }

  return { state: "unknown", ...where };
}

/**
 * The app that used to answer to this name, if it was renamed and is
 * still in this company.
 *
 * So a caller holding a stale name is told where the app went rather than
 * "no such app" — see middleware/deployTokenContext.ts. The audit-log
 * fallback is the case that matters: the callers still holding an old
 * name are the ones that have been idle, likely across a restart.
 */
export async function findRenamedApp(
  companyId: string,
  oldSlug: string
): Promise<{ from: string; to: string; project: Project } | null> {
  // Every completed rename since SlugAlias existed, however many renames
  // ago — the in-memory and audit lookups below cover a rename still
  // finishing, and older ones.
  const alias = await prisma.slugAlias.findUnique({ where: { slug: oldSlug }, include: { project: true } });
  if (alias && alias.project.companyId === companyId) {
    return { from: oldSlug, to: alias.project.slug, project: alias.project };
  }

  const remembered = findRenameFrom(companyId, oldSlug);
  if (remembered && remembered.state !== "failed") {
    const project = await prisma.project.findFirst({ where: { slug: remembered.to, companyId } });
    if (project) return { from: remembered.from, to: remembered.to, project };
  }

  // Durable fallback. Scoped to the company first — `details` is free
  // text and must never be matched across a tenant boundary.
  const rows = await prisma.auditLog.findMany({
    where: { companyId, action: { in: [...SLUG_CHANGE_AUDIT_ACTIONS] } },
    orderBy: { createdAt: "desc" },
    select: { details: true, projectId: true },
    take: 50,
  });

  for (const row of rows) {
    const pair = parseSlugChangeDetails(row.details);
    if (!pair || pair.from !== oldSlug || !row.projectId) continue;
    const project = await prisma.project.findFirst({ where: { id: row.projectId, companyId } });
    // Only report it if the app really is on the name we'd send them to.
    // A later rename, or a rollback, makes this row stale.
    if (project && project.slug === pair.to) return { from: pair.from, to: pair.to, project };
  }

  return null;
}
