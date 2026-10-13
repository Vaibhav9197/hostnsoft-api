/**
 * Deletes expired orphan projects — see docs/Anonymous-deploy-req.md #7.
 * Runs hourly (configurable). For each expired orphan: tear down its
 * running app on hostnsoft-deploy (Nomad job + Traefik routing that
 * comes with it, plus any Docker image), then delete the DB row.
 *
 * Best-effort on the teardown call, same pattern as every other
 * fire-and-forget internal call in this codebase (record-deployment.js's
 * own reasoning, mirrored here): a hostnsoft-deploy outage must never
 * block the DB row from being cleaned up, or an expired orphan would
 * pile up forever waiting for a teardown that keeps failing. A failed
 * teardown is logged for manual follow-up, not retried indefinitely.
 *
 * The one exception is a deploy still in flight (tearDownApp's "busy"):
 * that orphan is skipped and picked up again next run, once the deploy has
 * finished. Nothing new can start on it meanwhile — an expired orphan
 * can't be redeployed, adopted or claimed (projectClaim.ts's
 * unexpiredOrphanWhere) — so this only ever waits out a deploy that began
 * before the 24 hours ran out.
 */
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { tearDownApp } from "./appTeardown";
import { ORPHAN_CLEANUP_INTERVAL_MS } from "../lib/orphanConfig";

async function cleanupExpiredOrphans(): Promise<void> {
  const expired = await prisma.project.findMany({
    where: { isOrphan: true, orphanExpiresAt: { lt: new Date() } },
  });

  for (const project of expired) {
    const teardown = await tearDownApp(project.slug, { ifIdle: true });
    if (teardown === "busy") {
      logger.info(`[orphanCleanup] "${project.slug}" has a deploy in progress, left for the next run`);
      continue;
    }
    try {
      // Re-checked in the delete itself, not trusted from the list read
      // above: only a row that is STILL an expired orphan goes. Anything
      // that took the app over since is never deleted here.
      const removed = await prisma.project.deleteMany({
        where: { id: project.id, isOrphan: true, orphanExpiresAt: { lt: new Date() } },
      });
      if (removed.count === 0) {
        logger.warn(`[orphanCleanup] "${project.slug}" is no longer an expired orphan, project row kept`);
        continue;
      }
      logger.info(`[orphanCleanup] removed expired orphan project "${project.slug}"`);
    } catch (e) {
      logger.error(`[orphanCleanup] could not delete project row for "${project.slug}": ${(e as Error).message}`);
    }
  }
}

export function startOrphanCleanupLoop(): void {
  setInterval(() => {
    cleanupExpiredOrphans().catch((e) => {
      logger.error(`[orphanCleanup] loop iteration failed: ${(e as Error).message}`);
    });
  }, ORPHAN_CLEANUP_INTERVAL_MS);
}
