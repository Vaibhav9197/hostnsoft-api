/**
 * Backs GET /companies/:companyId/projects/:projectId's health field —
 * proxies hostnsoft-deploy's real Nomad allocation status (see
 * hostnsoft-deploy's app-health.js for the simplified status vocabulary:
 * running/crashed/starting/stopped/not_deployed/unknown). Best-effort,
 * same pattern as appTeardown.ts: a hostnsoft-deploy outage must never
 * fail the whole project-detail request, so any failure just falls back
 * to "unknown" — the exact value this replaced.
 */
import { logger } from "../lib/logger";
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";

export async function fetchAppHealth(slug: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${slug}/status`, {
      headers: { "X-Internal-Secret": INTERNAL_API_SECRET },
    });
  } catch (e) {
    logger.error(`[appHealth] could not reach hostnsoft-deploy fetching health for "${slug}": ${(e as Error).message}`);
    return "unknown";
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[appHealth] hostnsoft-deploy returned HTTP ${response.status} fetching health for "${slug}": ${bodyText}`);
    return "unknown";
  }

  const body = (await response.json().catch(() => null)) as { health?: unknown } | null;
  return typeof body?.health === "string" ? body.health : "unknown";
}
