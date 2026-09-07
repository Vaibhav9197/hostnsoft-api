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
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";

interface PushResult {
  pushed: boolean;
  error?: string;
}

export async function pushCustomDomainConfig(projectId: string): Promise<PushResult> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const latestSuccess = await prisma.deployment.findFirst({
    where: { projectId, status: "success" },
    orderBy: { createdAt: "desc" },
  });

  if (!latestSuccess) {
    // Nothing has ever deployed successfully — there's no running Nomad
    // job to update. Not a failure: the project's first deploy already
    // picks up active domains itself (see
    // hostnsoft-deploy/claim-project.js and
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

  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${project.slug}/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        imageTag: latestSuccess.imageTag,
        memoryMb: effectiveMemoryMb,
        customDomains: activeDomains.map((d) => d.domain),
        envVars,
      }),
    });
  } catch (e) {
    const message = (e as Error).message;
    logger.error(`[pushCustomDomainConfig] could not reach hostnsoft-deploy for project ${project.slug}: ${message}`);
    return { pushed: false, error: message };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(
      `[pushCustomDomainConfig] hostnsoft-deploy returned HTTP ${response.status} for project ${project.slug}: ${bodyText}`
    );
    return { pushed: false, error: `hostnsoft-deploy returned HTTP ${response.status}` };
  }

  return { pushed: true };
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
