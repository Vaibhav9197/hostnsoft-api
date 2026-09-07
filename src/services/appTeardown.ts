/**
 * Tears down an app's running Nomad job (and, by extension, its Traefik
 * routing, which Traefik derives directly from the job) plus any Docker
 * image, via hostnsoft-deploy's DELETE /internal/apps/:appName. Shared
 * by orphan cleanup (docs/Anonymous-deploy-req.md #7) and regular
 * project deletion (src/routes/projects.routes.ts) — both need the exact
 * same "make sure nothing keeps running" step, previously only wired up
 * for the orphan case.
 *
 * Best-effort: logs and returns rather than throwing, so a
 * hostnsoft-deploy outage never blocks the caller's own DB cleanup —
 * same reasoning as every other fire-and-forget internal call in this
 * codebase (record-deployment.js's, on the other side of this same
 * trust boundary).
 */
import { logger } from "../lib/logger";
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";

export async function tearDownApp(slug: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${slug}`, {
      method: "DELETE",
      headers: { "X-Internal-Secret": INTERNAL_API_SECRET },
    });
  } catch (e) {
    logger.error(`[appTeardown] could not reach hostnsoft-deploy tearing down "${slug}": ${(e as Error).message}`);
    return;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[appTeardown] hostnsoft-deploy returned HTTP ${response.status} tearing down "${slug}": ${bodyText}`);
  }
}
