/**
 * Re-applying an app's configuration against an existing image, with no
 * rebuild — the mechanism behind both rollback and "make my env var
 * changes take effect".
 *
 * Both are the same operation with a different image: regenerate the Nomad
 * job spec from the project's CURRENT configuration (domains, env vars,
 * memory) and push it. Rollback points at a past image; applying config
 * points at the one already running. Keeping them in one place means the
 * subtle parts — the memory floor, deleting the placeholder row when the
 * push is refused, recording the result as a new deployment rather than
 * rewriting history — can't drift apart.
 *
 * Extracted from deployments.routes.ts so the dashboard route and the
 * agent routes (routes/agentApps.routes.ts) run the same code. Returns a
 * tagged outcome rather than throwing or writing a response: the callers
 * report the same conditions differently (a person in the dashboard, a
 * machine branching on `code`), and only the route layer should choose
 * status codes.
 */
import type { Deployment, Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { pushAppConfig } from "./customDomainActivation";
import { createDeploymentWithNextVersion } from "./deploymentVersioning";
import { isRenameInProgress } from "./renameStatus";
import type { DeployAttribution } from "../lib/deployAttribution";

type Succeeded = { ok: true; deployment: Deployment; target: Deployment };

// Failures the push itself can produce, whichever image it was given.
type PushFailure =
  | { ok: false; code: "rollback_image_unavailable"; retainCount: number }
  | { ok: false; code: "rollback_push_failed"; error: string }
  | { ok: false; code: "rename_in_progress" };

type PushOutcome = Succeeded | PushFailure;

// The two entry points fail in different ways, and saying so in the types is
// what lets each caller handle only what it can actually receive. Widening
// both to one union meant the dashboard's rollback route had to handle
// "no_current_deployment" — a case it can never get — and TypeScript
// rightly refused to let it read `.error` off a member that has none.
export type RollbackOutcome =
  | PushOutcome
  | { ok: false; code: "deployment_not_found" }
  | { ok: false; code: "rollback_not_successful_deployment" };

export type ApplyConfigOutcome = PushOutcome | { ok: false; code: "no_current_deployment" };

/** Everything either entry point can return — for code that handles both. */
export type RedeployOutcome = RollbackOutcome | ApplyConfigOutcome;

/**
 * The shared body. `target` supplies the image; everything else is read
 * live from the project, which is why a rollback keeps today's env vars
 * and domains rather than restoring the ones in effect at that version.
 */
async function pushWithImage(
  project: Project,
  target: Deployment,
  attribution: DeployAttribution
): Promise<PushOutcome> {
  // Every push below addresses hostnsoft-deploy by project.slug, read
  // once here. An address change moves that job out from under us — it
  // stops the old Nomad job partway through — so a push landing in that
  // window targets a job that is being torn down, and hostnsoft-deploy's
  // purgeIfNotRunning can then purge it out from under the rollback
  // path. projectSlugChange.ts refuses a rename while a deploy is in
  // flight for exactly this reason; this is the same interlock in the
  // other direction, which was missing.
  //
  // Here rather than in the two entry points because both funnel through
  // this function, and a third would inherit it for free.
  if (isRenameInProgress(project.id)) {
    return { ok: false, code: "rename_in_progress" };
  }

  const activeDomains = await prisma.domain.findMany({
    where: { projectId: project.id, status: "active" },
    select: { domain: true },
  });
  const envVars = await prisma.envVar.findMany({
    where: { projectId: project.id },
    select: { key: true, value: true },
  });

  // The memory floor this specific image actually needs (e.g. an
  // embedded-DB dependency present at that version) isn't necessarily
  // today's floor if dependencies changed since — same Math.max reasoning
  // as customDomainActivation.ts, floored against the TARGET deployment's
  // own recorded memory instead of the latest one.
  const effectiveMemoryMb = Math.max(project.memoryMb, target.memoryMb ?? 0);

  // Created BEFORE the push (status "in_progress", no finishedAt) so
  // there's something to poll immediately, and so hostnsoft-deploy's async
  // completion callback has a stable id to report against however long the
  // Nomad apply takes.
  const deployment = await createDeploymentWithNextVersion(project.id, {
    appVersion: target.appVersion,
    imageTag: target.imageTag,
    memoryMb: effectiveMemoryMb,
    status: "in_progress",
    ...attribution,
  });

  const result = await pushAppConfig(project, {
    imageTag: target.imageTag!,
    memoryMb: effectiveMemoryMb,
    customDomains: activeDomains.map((d) => d.domain),
    envVars,
    deploymentId: deployment.id,
  });

  if (!result.pushed) {
    // No "in progress" row should be left behind for a call that failed
    // before hostnsoft-deploy did anything.
    await prisma.deployment.delete({ where: { id: deployment.id } });
    if (result.code === "image_unavailable") {
      return { ok: false, code: "rollback_image_unavailable", retainCount: result.retainCount ?? 5 };
    }
    return { ok: false, code: "rollback_push_failed", error: result.error ?? "unknown" };
  }

  return { ok: true, deployment, target };
}

export async function rollbackToDeployment(
  project: Project,
  targetDeploymentId: string,
  attribution: DeployAttribution
): Promise<RollbackOutcome> {
  const target = await prisma.deployment.findFirst({
    where: { id: targetDeploymentId, projectId: project.id },
  });
  if (!target) return { ok: false, code: "deployment_not_found" };
  if (target.status !== "success" || !target.imageTag) {
    return { ok: false, code: "rollback_not_successful_deployment" };
  }
  return pushWithImage(project, target, attribution);
}

/**
 * Re-push the currently running image so configuration changed since the
 * last deploy — env vars, in practice — actually reaches the container.
 *
 * Env vars are baked into the job spec at deploy time, so writing one to
 * the database changes nothing about the running app until something
 * regenerates that spec. Before this existed the only way to apply one was
 * a full source re-upload and rebuild, which an agent can't do when the
 * variable is the very thing the app needs in order to boot.
 */
export async function applyCurrentConfig(
  project: Project,
  attribution: DeployAttribution
): Promise<ApplyConfigOutcome> {
  if (!project.currentDeploymentId) {
    return { ok: false, code: "no_current_deployment" };
  }
  const current = await prisma.deployment.findFirst({
    where: { id: project.currentDeploymentId, projectId: project.id },
  });
  // A project pointing at a deployment that isn't a usable image has
  // nothing to re-push; deploying the source is the only way forward.
  if (!current || current.status !== "success" || !current.imageTag) {
    return { ok: false, code: "no_current_deployment" };
  }
  return pushWithImage(project, current, attribution);
}
