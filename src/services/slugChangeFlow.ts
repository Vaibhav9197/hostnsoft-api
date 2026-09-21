/**
 * Running an address change end to end, for whichever surface asked for
 * it.
 *
 * services/projectSlugChange.ts owns the POLICY (what a name may be,
 * which of the two paths an app needs) and the MECHANICS (the single
 * UPDATE, or the migration). What it deliberately does not know about is
 * in-flight state, the audit log, or that a caller is waiting. Those are
 * the parts the dashboard route grew for itself, and they are exactly
 * the parts a second caller must not re-implement: the in-progress
 * interlock, the audit row the cooldown is later read from, and the
 * start/finish bookkeeping a poller reads.
 *
 * So they live here, composed on top of that service — the same
 * relationship services/redeploy.ts has to the pieces it orchestrates.
 * Both routes call startSlugChange and then decide only how to spell the
 * answer. Anything that changes about how a rename is carried out
 * changes once, for both.
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
 * Exported as data and shared by both routes, which bends the rule in
 * redeploy.ts that "only the route layer should choose status codes".
 * Deliberately: that rule has already let the same code mean two
 * statuses on two surfaces (`no_current_deployment` is 409 here and 422
 * on the redeploy path), and an HTTP status for a machine-readable code
 * is a property of the code, not of who is reading it. What stays with
 * the routes is the part that really is audience-specific — the prose,
 * and the extra fields alongside it.
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

  const audit = (previousSlug: string, nextSlug: string) =>
    logAudit({
      actorUserId,
      companyId,
      projectId: project.id,
      action: SLUG_CHANGE_AUDIT_ACTION,
      details: slugChangeDetails(previousSlug, nextSlug, actorNote),
    });

  // Re-submitting the address it already has changes nothing, so no
  // audit row — an audit log should record what happened, and nothing
  // did. (It also must not start a cooldown.)
  if (plan.unchanged) return { ok: true, kind: "unchanged", project };

  if (!plan.live) {
    const outcome = await applyDatabaseOnlySlugChange(project, plan.slug);
    if (!outcome.ok) return { ok: false, code: outcome.code, reason: outcome.reason };
    await audit(outcome.previousSlug, outcome.project.slug);
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
      if (outcome.ok) await audit(outcome.previousSlug, outcome.project.slug);
      markRenameFinished(
        project.id,
        outcome.ok ? { ok: true } : { ok: false, code: outcome.code, reason: outcome.reason }
      );
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
 * Two sources, in order, because the in-memory record is fast and
 * complete but not durable:
 *
 *   1. renameStatus, authoritative while this process lives.
 *   2. the audit log, if the map has nothing. A row whose target is the
 *      app's CURRENT slug means the move happened and was recorded —
 *      true across a restart, and true on an instance that didn't run
 *      the migration.
 *
 * That second step is not a contradiction of renameStatus.ts's argument
 * against persistence. That argument is about the IN-PROGRESS state,
 * which genuinely cannot outlive the process running it; this only ever
 * answers about a finished one.
 *
 * Every state carries currentSlug, so a caller never has to infer where
 * the app actually is from an HTTP status.
 */
export async function resolveSlugChangeStatus(project: Project): Promise<SlugChangeView> {
  const where = { currentSlug: project.slug, appUrl: platformAppUrl(project.slug) };

  const live = getRenameStatus(project.id);
  if (live) return { ...live, ...where };

  const last = await prisma.auditLog.findFirst({
    where: { projectId: project.id, action: SLUG_CHANGE_AUDIT_ACTION },
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
 * Exists so a caller holding a stale name gets told where the app went
 * rather than "no such app" — see middleware/deployTokenContext.ts. The
 * in-memory record answers immediately after a rename; the audit log
 * answers afterwards and across restarts, which is the case that
 * matters, because the callers most likely to still be holding an old
 * name are the ones that have been idle.
 */
export async function findRenamedApp(
  companyId: string,
  oldSlug: string
): Promise<{ from: string; to: string; project: Project } | null> {
  const remembered = findRenameFrom(companyId, oldSlug);
  if (remembered && remembered.state !== "failed") {
    const project = await prisma.project.findFirst({ where: { slug: remembered.to, companyId } });
    if (project) return { from: remembered.from, to: remembered.to, project };
  }

  // Durable fallback. Scoped to the company first — `details` is free
  // text and must never be matched across a tenant boundary.
  const rows = await prisma.auditLog.findMany({
    where: { companyId, action: SLUG_CHANGE_AUDIT_ACTION },
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
