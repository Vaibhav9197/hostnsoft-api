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

// "busy" only ever comes back when ifIdle was asked for: hostnsoft-deploy
// has a deploy of this app in flight and left the app alone. "failed" is
// everything else that didn't tear it down — unreachable, or an error.
export type TeardownOutcome = "ok" | "busy" | "failed";

// ifIdle: refuse rather than tear down mid-deploy. Orphan cleanup asks for
// it — an expired orphan can wait for the next run, and tearing it down
// under a deploy that is still building leaves that build to come up
// afterwards with nothing behind it. Deleting a project, an agent app or
// a renamed app's old name doesn't, and behaves exactly as before.
export async function tearDownApp(slug: string, opts: { ifIdle?: boolean } = {}): Promise<TeardownOutcome> {
  const query = opts.ifIdle ? "?ifIdle=1" : "";
  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${slug}${query}`, {
      method: "DELETE",
      headers: { "X-Internal-Secret": INTERNAL_API_SECRET },
    });
  } catch (e) {
    logger.error(`[appTeardown] could not reach hostnsoft-deploy tearing down "${slug}": ${(e as Error).message}`);
    return "failed";
  }

  if (response.ok) return "ok";

  const bodyText = await response.text().catch(() => "<unreadable response body>");
  if (opts.ifIdle && response.status === 409 && errorCode(bodyText) === "deploy_in_progress") {
    return "busy";
  }
  logger.error(`[appTeardown] hostnsoft-deploy returned HTTP ${response.status} tearing down "${slug}": ${bodyText}`);
  return "failed";
}

function errorCode(bodyText: string): string | undefined {
  try {
    return (JSON.parse(bodyText) as { code?: string }).code;
  } catch {
    return undefined;
  }
}
