/**
 * Pushes a project's current set of *active* custom domains to
 * hostnsoft-deploy so it can regenerate and reapply the app's Nomad job
 * spec with one HTTP-01 router per domain — see
 * docs/Customdomain-req.md "Activating the router". Always sends the
 * project's full current active-domain list rather than a diff, so every
 * call (activate one, deactivate one, re-verification failure) is a
 * simple idempotent resync rather than requiring the caller to track
 * what changed.
 *
 * This is a new direction of trust (hostnsoft-api calling INTO
 * hostnsoft-deploy) — the reverse of every other internal call in this
 * codebase, hence the separate INTERNAL_API_SECRET rather than reusing
 * the per-company deploy-token mechanism, which is scoped the other way.
 */
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";

interface PushResult {
  pushed: boolean;
  error?: string;
  // Set when hostnsoft-deploy's response body carried a machine-readable
  // code (currently just "image_unavailable", from the rollback path) —
  // lets a caller like deployments.routes.ts's rollback handler branch
  // on the specific failure instead of only having an opaque string.
  code?: string;
  retainCount?: number;
}

interface AppConfig {
  imageTag: string;
  memoryMb: number;
  customDomains: string[];
  envVars: { key: string; value: string }[];
  // Present ONLY for rollback (deployments.routes.ts) — its presence is
  // what tells hostnsoft-deploy to take the ASYNC path: respond 202 the
  // moment the target image is confirmed to exist, apply the actual
  // Nomad job run in the background, and report the real outcome back to
  // POST /internal/deployments/:deploymentId/complete once it's done.
  // Omitted for pushCustomDomainConfig below, which needs the OLD
  // synchronous behavior preserved exactly — it marks a Domain "active"
  // the moment this call returns pushed:true, which would be premature
  // (active before the config is actually live) if that call ever
  // stopped meaning "fully applied."
  deploymentId?: string;
}

// Low-level call into hostnsoft-deploy's config-push endpoint — pushes a
// full desired app config (image, memory, domains, env vars) and applies
// it WITHOUT a rebuild. Shared by pushCustomDomainConfig below (always
// the project's current image) and deployments.routes.ts's rollback
// endpoint (a past image, current everything else) — both are "resync
// the whole job spec from a known-good state" operations, just with a
// different imageTag source.
//
// pushed:true means two DIFFERENT things depending on the caller, per
// deploymentId above: "fully applied" (no deploymentId — custom domains)
// vs. "accepted, applying asynchronously" (deploymentId set — rollback).
// This is a real asymmetry, not an oversight — see AppConfig's comment.
export async function pushAppConfig(project: Project, config: AppConfig): Promise<PushResult> {
  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${project.slug}/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_API_SECRET,
      },
      body: JSON.stringify(config),
    });
  } catch (e) {
    const message = (e as Error).message;
    logger.error(`[pushAppConfig] could not reach hostnsoft-deploy for project ${project.slug}: ${message}`);
    return { pushed: false, error: message };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(
      `[pushAppConfig] hostnsoft-deploy returned HTTP ${response.status} for project ${project.slug}: ${bodyText}`
    );
    // hostnsoft-deploy's error responses are JSON ({error, code?,
    // retainCount?}) but this is still best-effort parsing — an
    // unexpected non-JSON body (a proxy error page, etc.) just means
    // code/retainCount stay undefined, not a thrown error here.
    let code: string | undefined;
    let retainCount: number | undefined;
    try {
      const parsed = JSON.parse(bodyText) as { code?: string; retainCount?: number };
      code = parsed.code;
      retainCount = parsed.retainCount;
    } catch {
      // not JSON — leave code/retainCount undefined
    }
    return {
      pushed: false,
      error: bodyText || `hostnsoft-deploy returned HTTP ${response.status}`,
      code,
      retainCount,
    };
  }

  return { pushed: true };
}

export async function pushCustomDomainConfig(projectId: string): Promise<PushResult> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  // currentDeploymentId is kept up to date on every successful deploy AND
  // every successful rollback (internalDeployments.routes.ts,
  // deployments.routes.ts) — reading it directly instead of re-deriving
  // "the latest successful deployment" via its own query keeps this in
  // sync with rollback: a project rolled back to an old image must push
  // THAT image here, not whatever the most recent row by timestamp is
  // (which, before currentDeploymentId existed, happened to always be
  // correct too, since rollback itself creates the newest row — but that
  // was incidental, not guaranteed by this function's own logic).
  const latestSuccess = project.currentDeploymentId
    ? await prisma.deployment.findUnique({ where: { id: project.currentDeploymentId } })
    : null;

  if (!latestSuccess || !latestSuccess.imageTag) {
    // Nothing has ever deployed successfully (or that deployment somehow
    // has no image tag) — there's no running Nomad job to update. Not a
    // failure: the project's first deploy already picks up active
    // domains itself (see hostnsoft-deploy/claim-project.js and
    // src/routes/internalProjects.routes.ts), so this domain will be
    // wired in automatically once that happens.
    return { pushed: true };
  }

  const activeDomains = await prisma.domain.findMany({
    where: { projectId, status: "active" },
    select: { domain: true },
  });

  // Include the project's env vars too — this endpoint regenerates the
  // ENTIRE job spec from scratch (see hostnsoft-deploy's
  // /internal/apps/:appName/config), so omitting them here would silently
  // strip them from the running container the moment a custom domain is
  // activated/deactivated/re-verified, independent of anything the user
  // actually changed about their env vars.
  const envVars = await prisma.envVar.findMany({
    where: { projectId },
    select: { key: true, value: true },
  });

  // Defensive floor, on top of internalDeployments.routes.ts now keeping
  // Project.memoryMb itself up to date on every successful deploy: a
  // project that hasn't redeployed since that fix landed can still have
  // a stale (too-low) Project.memoryMb while its actual running task is
  // already at a higher, floor-adjusted memory (latestSuccess.memoryMb).
  // Never send less than whichever of the two is higher.
  const effectiveMemoryMb = Math.max(project.memoryMb, latestSuccess.memoryMb ?? 0);

  return pushAppConfig(project, {
    imageTag: latestSuccess.imageTag,
    memoryMb: effectiveMemoryMb,
    customDomains: activeDomains.map((d) => d.domain),
    envVars,
  });
}

interface ActivateResult {
  activated: boolean;
  error?: string;
}

export async function activateDomain(domainId: string): Promise<ActivateResult> {
  const domain = await prisma.domain.update({
    where: { id: domainId },
    data: { status: "active", lastVerifiedAt: new Date() },
  });

  const result = await pushCustomDomainConfig(domain.projectId);
  if (!result.pushed) {
    // DNS was genuinely fine — only the routing push failed. Roll back to
    // pending_dns (not "failed") so a retry via POST .../verify doesn't
    // need to re-prove DNS, just re-attempt the push.
    await prisma.domain.update({ where: { id: domainId }, data: { status: "pending_dns" } });
    return { activated: false, error: result.error };
  }

  return { activated: true };
}

// Used by the periodic re-verification loop when a previously-active
// domain's DNS no longer points at the platform — see
// src/services/domainReverification.ts and
// docs/Customdomain-req.md constraint #3.
export async function deactivateDomain(domainId: string): Promise<void> {
  const domain = await prisma.domain.update({
    where: { id: domainId },
    data: { status: "failed" },
  });
  await pushCustomDomainConfig(domain.projectId);
}
