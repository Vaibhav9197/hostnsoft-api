/**
 * The two pieces of a deploy-declared schedule list (docs/schedules.md
 * "Declared on deploy"):
 *
 * - ensureCronSecret: at claim time, before the build, so the secret is in
 *   the env block the new container starts with. The agent never sees or
 *   handles it; the app just reads process.env.CRON_SECRET.
 * - syncDeclaredSchedules: once that deploy has succeeded, make the app's
 *   schedules exactly the declared list. Matched by path, so a schedule
 *   that keeps its path keeps its id, run history, alert webhook and
 *   failure state; only timing and name follow the new declaration.
 */
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { logAudit } from "./audit";
import { nextRunAfter, type DeclaredSchedule } from "./schedules";

export const CRON_SECRET_KEY = "CRON_SECRET";

// Creates CRON_SECRET when the app has none. Never replaces one: the owner
// (or an earlier deploy) may have set it, and the running app relies on it.
export async function ensureCronSecret(projectId: string, actorUserId: string): Promise<boolean> {
  const existing = await prisma.envVar.findUnique({
    where: { projectId_key: { projectId, key: CRON_SECRET_KEY } },
    select: { id: true },
  });
  if (existing) return false;
  try {
    await prisma.envVar.create({
      data: {
        projectId,
        key: CRON_SECRET_KEY,
        value: crypto.randomBytes(32).toString("hex"),
        createdBy: actorUserId,
        updatedBy: actorUserId,
      },
    });
    return true;
  } catch {
    // A concurrent deploy created it first — same outcome.
    return false;
  }
}

export interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
}

export async function syncDeclaredSchedules(
  project: { id: string; companyId: string | null },
  declared: DeclaredSchedule[],
  actorUserId: string
): Promise<SyncResult> {
  const now = new Date();
  const existing = await prisma.schedule.findMany({ where: { projectId: project.id } });
  const byPath = new Map(existing.map((s) => [s.path, s]));
  const keep = new Set(declared.map((d) => d.path));
  const result: SyncResult = { created: 0, updated: 0, deleted: 0 };

  await prisma.$transaction(async (tx) => {
    for (const d of declared) {
      const name = d.name ?? null;
      const current = byPath.get(d.path);
      if (!current) {
        await tx.schedule.create({
          data: {
            projectId: project.id,
            cron: d.cron,
            timezone: d.timezone,
            path: d.path,
            name,
            enabled: true,
            nextRunAt: nextRunAfter(d.cron, d.timezone, now),
            createdBy: actorUserId,
          },
        });
        result.created++;
        continue;
      }
      const timingChanged = current.cron !== d.cron || current.timezone !== d.timezone || !current.enabled;
      if (!timingChanged && current.name === name) continue;
      await tx.schedule.update({
        where: { id: current.id },
        data: {
          cron: d.cron,
          timezone: d.timezone,
          name,
          // Declaring a schedule means "run this": a paused one resumes.
          enabled: true,
          ...(timingChanged && { nextRunAt: nextRunAfter(d.cron, d.timezone, now) }),
        },
      });
      result.updated++;
    }
    const stale = existing.filter((s) => !keep.has(s.path)).map((s) => s.id);
    if (stale.length) {
      await tx.schedule.deleteMany({ where: { id: { in: stale } } });
      result.deleted = stale.length;
    }
  });

  if (result.created || result.updated || result.deleted) {
    await logAudit({
      actorUserId,
      companyId: project.companyId ?? undefined,
      projectId: project.id,
      action: "schedule.sync",
      details: `deploy: +${result.created} ~${result.updated} -${result.deleted} (${declared.map((d) => `${d.cron} ${d.path}`).join("; ") || "none"})`,
    });
  }
  return result;
}
