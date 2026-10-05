/**
 * Asks hostnsoft-deploy to move a running app to a new name — its half
 * of a slug change for an app that has actually deployed.
 *
 * Unlike every other call in this direction (appHealth, appTeardown,
 * pushAppConfig), this one is NOT best-effort: the remote call IS the
 * operation. If it didn't happen the app still serves its old hostname,
 * and writing Project.slug anyway would point this service at a name that
 * resolves to nothing. So the caller gets a definite verdict and writes
 * the new slug only on a definite success.
 *
 * Deliberately slow, and deliberately without a timeout: hostnsoft-deploy
 * holds the response until the app is live under the new name with a real
 * certificate, or fully rolled back — minutes either way. Cutting the
 * connection wouldn't stop the migration, it would only lose the answer.
 */
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";
import { isFreePlanForDeploy } from "./companyPlan";

export type RenameAppResult =
  | { renamed: true; imageTag: string; domain: string }
  // `code` is hostnsoft-deploy's own machine-readable reason, passed
  // through rather than flattened, so the route can map it to a status
  // and a sentence a person can act on.
  | { renamed: false; code: string; error: string };

/**
 * The app's full desired configuration travels with the request, exactly
 * as it does for a config push: hostnsoft-deploy keeps no durable state
 * of its own, so it has to rebuild the whole job spec under the new name
 * and cannot know the memory, custom domains or env vars by itself.
 * Sending them is also what stops a rename from quietly reverting an
 * app's configuration to whatever was baked in at its last deploy.
 */
export async function renameApp(project: Project, newSlug: string): Promise<RenameAppResult> {
  const current = project.currentDeploymentId
    ? await prisma.deployment.findUnique({ where: { id: project.currentDeploymentId } })
    : null;

  if (!current?.imageTag) {
    // Nothing is running, so there is nothing for hostnsoft-deploy to
    // move. The caller handles this case on its own (a slug change with
    // no deployment is a plain database write) and should never get here.
    return {
      renamed: false,
      code: "no_current_deployment",
      error: "This app has no running deployment to move.",
    };
  }

  const [activeDomains, envVars] = await Promise.all([
    prisma.domain.findMany({ where: { projectId: project.id, status: "active" }, select: { domain: true } }),
    prisma.envVar.findMany({ where: { projectId: project.id }, select: { key: true, value: true } }),
  ]);

  // Same floor as every other push: Project.memoryMb can lag behind what
  // the running task was actually given (see customDomainActivation.ts),
  // and a rename must never quietly shrink an app.
  const memoryMb = Math.max(project.memoryMb, current.memoryMb ?? 0);
  // The new job is built from scratch: without this a free app comes back
  // under its new name without its footer.
  const isFreePlan = await isFreePlanForDeploy(project.companyId);

  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${project.slug}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": INTERNAL_API_SECRET },
      body: JSON.stringify({
        newName: newSlug,
        imageTag: current.imageTag,
        memoryMb,
        customDomains: activeDomains.map((d) => d.domain),
        envVars,
        isFreePlan,
      }),
    });
  } catch (e) {
    const message = (e as Error).message;
    logger.error(`[appRename] could not reach hostnsoft-deploy renaming "${project.slug}" to "${newSlug}": ${message}`);
    return { renamed: false, code: "deploy_unreachable", error: message };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(
      `[appRename] hostnsoft-deploy returned HTTP ${response.status} renaming "${project.slug}" to "${newSlug}": ${bodyText}`
    );
    let code: string | undefined;
    let error: string | undefined;
    try {
      const parsed = JSON.parse(bodyText) as { code?: string; error?: string };
      code = parsed.code;
      error = parsed.error;
    } catch {
      // Not JSON (a proxy error page, say) — fall through to the generic.
    }
    return {
      renamed: false,
      code: code ?? "rename_failed",
      error: error ?? `hostnsoft-deploy returned HTTP ${response.status}`,
    };
  }

  const body = (await response.json().catch(() => null)) as { imageTag?: string; domain?: string } | null;
  logger.info(`[appRename] hostnsoft-deploy moved "${project.slug}" to "${newSlug}"`);
  return { renamed: true, imageTag: body?.imageTag ?? "", domain: body?.domain ?? "" };
}
