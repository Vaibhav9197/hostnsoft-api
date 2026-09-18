/**
 * In-process record of address changes currently being carried out, and
 * how the last one for each project ended.
 *
 * Why this exists at all: moving a live app takes minutes (a Nomad job
 * swap plus a fresh ACME order), and nothing in front of this service
 * will hold a request that long — the dashboard's own proxy gives up
 * after ten seconds. So the route answers immediately and the work
 * continues behind it, which leaves the caller needing somewhere to read
 * the result from. This is that somewhere.
 *
 * Deliberately in memory, and deliberately NOT a table. The exact same
 * reasoning as hostnsoft-deploy's deploy-status.js: the operation cannot
 * outlive the process that is running it, so a record that outlives the
 * process would only ever describe a migration that is no longer
 * happening — worse than no record, because it reads as authoritative. A
 * restart mid-migration is already a broken migration; losing the status
 * entry with it is not a second failure.
 *
 * What that costs: with more than one instance of this service, a client
 * can poll the instance that isn't running its migration and be told
 * "nothing in progress". Acceptable today (single instance), and the
 * honest fix if that changes is a table plus a worker, not a sticky
 * session — noted here so the choice is re-made deliberately rather than
 * discovered.
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

const byProjectId = new Map<string, RenameStatus>();

// A finished entry is kept only long enough for the client that started
// it to come back and read the outcome, then dropped — this map would
// otherwise grow for the life of the process. Generous because the
// reader may be a person who walked away from the tab.
const KEEP_FINISHED_MS = 30 * 60 * 1000;

export function markRenameStarted(projectId: string, from: string, to: string): void {
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
