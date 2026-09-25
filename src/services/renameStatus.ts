/**
 * In-process record of address changes currently being carried out, and
 * how the last one for each project ended.
 *
 * Moving a live app takes minutes and no proxy will hold a request that
 * long, so the route answers immediately and the work continues behind
 * it. This is where the caller reads the result from.
 *
 * In memory, not a table — same reasoning as hostnsoft-deploy's
 * deploy-status.js: the operation cannot outlive the process running it,
 * so a durable record would only ever describe a migration that is no
 * longer happening, which reads as authoritative and is worse than none.
 *
 * The cost: multi-instance, a client can poll the instance that isn't
 * running its migration and be told "nothing in progress". Fine at one
 * instance; the honest fix is a table plus a worker, not sticky sessions.
 */
import { logger } from "../lib/logger";

export type RenameStatus =
  | { state: "in_progress"; from: string; to: string; startedAt: string }
  | { state: "succeeded"; from: string; to: string; startedAt: string; finishedAt: string }
  | {
      state: "failed";
      from: string;
      to: string;
      startedAt: string;
      finishedAt: string;
      code: string;
      reason: string;
    };

// The company each in-flight rename belongs to, kept alongside rather
// than on RenameStatus so the shape a caller reads back is unchanged.
// Needed because two lookups below are keyed by NAME rather than by
// project id, and a name is only unique platform-wide for projects that
// currently exist — a rename in flight has a target that belongs to
// nobody yet, so the company is the only thing that makes "is this
// mine?" answerable.
const companyByProjectId = new Map<string, string>();

const byProjectId = new Map<string, RenameStatus>();

// A finished entry is kept only long enough for the client that started
// it to come back and read the outcome, then dropped — this map would
// otherwise grow for the life of the process. Generous because the
// reader may be a person who walked away from the tab.
const KEEP_FINISHED_MS = 30 * 60 * 1000;

export function markRenameStarted(projectId: string, companyId: string, from: string, to: string): void {
  companyByProjectId.set(projectId, companyId);
  byProjectId.set(projectId, { state: "in_progress", from, to, startedAt: new Date().toISOString() });
}

export function markRenameFinished(
  projectId: string,
  outcome: { ok: true } | { ok: false; code: string; reason: string }
): void {
  const started = byProjectId.get(projectId);
  if (!started) return;
  const finishedAt = new Date().toISOString();
  const base = { from: started.from, to: started.to, startedAt: started.startedAt, finishedAt };

  byProjectId.set(
    projectId,
    outcome.ok
      ? { state: "succeeded", ...base }
      : { state: "failed", ...base, code: outcome.code, reason: outcome.reason }
  );

  setTimeout(() => {
    // Only if nothing newer has started since — otherwise this timer
    // would delete a migration that is currently running.
    const current = byProjectId.get(projectId);
    if (current && current.state !== "in_progress" && current.startedAt === started.startedAt) {
      byProjectId.delete(projectId);
      companyByProjectId.delete(projectId);
    }
  }, KEEP_FINISHED_MS).unref?.();

  if (!outcome.ok) {
    logger.warn(`[renameStatus] project ${projectId}: ${started.from} -> ${started.to} failed (${outcome.code})`);
  }
}

export function getRenameStatus(projectId: string): RenameStatus | null {
  return byProjectId.get(projectId) ?? null;
}

export function isRenameInProgress(projectId: string): boolean {
  return byProjectId.get(projectId)?.state === "in_progress";
}

/**
 * Is a rename currently moving some app in this company ONTO this name?
 *
 * The target of an in-flight rename is a name no project holds yet —
 * this service writes it only once the migration succeeds. So a
 * uniqueness check against the Project table cannot see it, and a deploy
 * claiming that name mid-migration would create a second project on it
 * (see routes/internalProjects.routes.ts). This is the only way to
 * refuse that before it happens.
 */
export function isRenameTargeting(companyId: string, slug: string): boolean {
  for (const [projectId, status] of byProjectId) {
    if (status.state !== "in_progress") continue;
    if (status.to !== slug) continue;
    if (companyByProjectId.get(projectId) === companyId) return true;
  }
  return false;
}

/**
 * Where an app that USED to answer to this name went, if this process
 * carried out the move. Lets a caller still holding the old name be told
 * the new one instead of a bare "no such app".
 *
 * In-memory only, so it answers for roughly KEEP_FINISHED_MS after a
 * rename and not at all after a restart. Callers fall back to the audit
 * log, which is durable — this is just the fast path.
 */
export function findRenameFrom(companyId: string, oldSlug: string): RenameStatus | null {
  for (const [projectId, status] of byProjectId) {
    if (status.from !== oldSlug) continue;
    if (companyByProjectId.get(projectId) === companyId) return status;
  }
  return null;
}
