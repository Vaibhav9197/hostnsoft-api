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
 */
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";
import { ORPHAN_CLEANUP_INTERVAL_MS } from "../lib/orphanConfig";

async function tearDownApp(slug: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${slug}`, {
      method: "DELETE",
      headers: { "X-Internal-Secret": INTERNAL_API_SECRET },
    });
  } catch (e) {
    logger.error(`[orphanCleanup] could not reach hostnsoft-deploy tearing down "${slug}": ${(e as Error).message}`);
    return;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[orphanCleanup] hostnsoft-deploy returned HTTP ${response.status} tearing down "${slug}": ${bodyText}`);
  }
}

async function cleanupExpiredOrphans(): Promise<void> {
  const expired = await prisma.project.findMany({
    where: { isOrphan: true, orphanExpiresAt: { lt: new Date() } },
  });

  for (const project of expired) {
    await tearDownApp(project.slug);
    try {
      await prisma.project.delete({ where: { id: project.id } });
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
