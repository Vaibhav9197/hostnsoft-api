/**
 * Changing an app's slug — the hostname it answers on, the Nomad job
 * name, and the X-App-Name an agent deploys with.
 *
 * Kept out of the route because almost all of this (normalisation,
 * reserved-name policy, platform-wide uniqueness, the showcase-snapshot
 * and audit bookkeeping) is exactly what a LIVE rename needs too. Only
 * the "what happens to the running app" step differs, and that step is
 * the one that doesn't exist yet on either side.
 *
 * Returns a tagged outcome rather than writing a response, same shape as
 * services/redeploy.ts: the route layer owns status codes.
 *
 * ---------------------------------------------------------------------
 * SCOPE TODAY: apps that have never successfully deployed.
 *
 * On hostnsoft-deploy there is no project id at all — the slug IS the
 * Nomad job name, the Traefik router names, the Docker image repository,
 * the app's data directory on the host, and the app_name column in the
 * analytics tables. So renaming a LIVE app is a migration (stop the job,
 * move the data directory, re-tag the images, run the new job, wait for
 * a fresh Let's Encrypt certificate on the new hostname, purge the old
 * job, rewrite the analytics rows), and it needs a new internal endpoint
 * on that side to carry it out. Until that exists, an app with anything
 * running is refused here rather than half-migrated: pushing a config
 * under a new name would start a SECOND Nomad job pointed at a brand-new
 * empty data directory while the old one kept serving, which for any app
 * with an embedded database is silent data loss.
 *
 * The platform zone has no wildcard certificate (verified against
 * Certificate Transparency and a live handshake — every app holds its
 * own single-name Let's Encrypt cert), so a live rename also spends a
 * certificate from the zone's weekly issuance budget. DNS, by contrast,
 * is a wildcard, so no DNS work is involved either way.
 * ---------------------------------------------------------------------
 */
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { checkSlug } from "../lib/reservedSlugs";
import { fetchAppHealth } from "./appHealth";
import { tearDownApp } from "./appTeardown";
import { platformAppUrl } from "./showcase";

// Matches hostnsoft-deploy's own X-App-Name check (server.js) and the
// claim endpoint's zod schema. checkSlug deliberately does NOT cover the
// character set — it only judges length, hyphen placement, punycode and
// the reserved list — so this has to be applied alongside it, not
// instead of it.
const SLUG_PATTERN = /^[a-z0-9-]+$/;

export type SlugChangeFailure =
  | "invalid_app_name"
  | "app_name_too_short"
  | "app_name_too_long"
  | "app_name_reserved"
  | "app_name_taken"
  | "app_is_deployed"
  | "app_state_unknown";

export type SlugChangeOutcome =
  | { ok: true; project: Project; previousSlug: string; unchanged: boolean }
  | { ok: false; code: SlugChangeFailure; reason: string };

/**
 * Whether this project is safe to rename with nothing but a database
 * write — i.e. nothing exists on the deploy host under the old name.
 *
 * Two independent checks, because neither alone is trustworthy:
 *
 * - `currentDeploymentId` is our own record of a successful deploy. But
 *   hostnsoft-deploy reports deploy outcomes back to us fire-and-forget
 *   (record-deployment.js), so a deploy that succeeded and whose callback
 *   then failed leaves a RUNNING app with no row here saying so.
 * - So also ask the deploy host directly. Only its explicit
 *   "not_deployed" (no Nomad job of that name at all) is accepted.
 *
 * Fail closed on "unknown": that is what fetchAppHealth returns when
 * hostnsoft-deploy is unreachable or errors, and treating "I couldn't
 * ask" as "nothing is there" is how you delete a live app's data.
 */
async function assertNothingDeployed(project: Project): Promise<SlugChangeOutcome | null> {
  if (project.currentDeploymentId) {
    return {
      ok: false,
      code: "app_is_deployed",
      reason:
        "This app has been deployed, and its web address can't be changed yet. " +
        "Deployed apps need their running container, stored data and certificate " +
        "migrated to the new address, which isn't supported yet.",
    };
  }

  const health = await fetchAppHealth(project.slug);
  if (health === "not_deployed") return null;

  if (health === "unknown") {
    return {
      ok: false,
      code: "app_state_unknown",
      reason:
        "Couldn't confirm whether this app is currently running, so its web " +
        "address wasn't changed. Try again in a moment.",
    };
  }

  // Running/starting/crashed/stopped with no recorded deployment — the
  // failed-callback case above. Renaming would strand a live Nomad job
  // under the old name.
  return {
    ok: false,
    code: "app_is_deployed",
    reason:
      "This app is already running on the platform, so its web address can't " +
      "be changed yet, even though no successful deployment was recorded for it.",
  };
}

/**
 * Showcase listings snapshot the app's URL at submit time (see
 * services/showcase.ts — deliberately a snapshot, not a live join). Only
 * rewrite the ones that were pointing at the OLD platform hostname: a
 * listing snapshotted against a custom domain is still accurate, and
 * "fixing" it would silently swap a listing's address for a different
 * one the submitter never chose.
 */
async function repointShowcaseListings(projectId: string, previousSlug: string, nextSlug: string): Promise<void> {
  const stale = platformAppUrl(previousSlug);
  const fresh = platformAppUrl(nextSlug);
  const { count } = await prisma.showcaseProject.updateMany({
    where: { projectId, appUrl: stale },
    data: { appUrl: fresh },
  });
  if (count > 0) {
    logger.info(`[projectSlugChange] repointed ${count} showcase listing(s) from ${stale} to ${fresh}`);
  }
}

export async function changeProjectSlug(project: Project, requestedSlug: string): Promise<SlugChangeOutcome> {
  const slug = requestedSlug.trim().toLowerCase();

  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      code: "invalid_app_name",
      reason: "Web addresses can only contain lowercase letters, digits and hyphens.",
    };
  }

  // Idempotent no-op before any of the expensive checks — re-submitting
  // the address an app already has is not an error, and must not be
  // refused by the reserved-name rule below for an app that legitimately
  // predates that list.
  if (slug === project.slug) {
    return { ok: true, project, previousSlug: project.slug, unchanged: true };
  }

  // Deliberately NOT via projectClaim.ts's slugRejection(), which skips
  // the reserved check when a project already holds the name. That
  // grandfathering exists so an app claimed before the reserved list
  // shipped keeps deploying; a rename is a brand-new claim, so inheriting
  // it would let any app move itself onto `login`, `api` or `ship` —
  // precisely the hostname-takeover case lib/reservedSlugs.ts exists to
  // prevent.
  const reserved = checkSlug(slug);
  if (reserved.reserved) {
    return { ok: false, code: reserved.code as SlugChangeFailure, reason: reserved.reason };
  }

  const blocked = await assertNothingDeployed(project);
  if (blocked) return blocked;

  const previousSlug = project.slug;

  // create-then-catch, not check-then-write: the slug is unique
  // platform-wide and a concurrent claim (a deploy of that same name
  // landing right now) must lose on the constraint rather than on a
  // read that was already stale by the time we wrote. Same pattern as
  // services/projectClaim.ts.
  let updated: Project;
  try {
    updated = await prisma.project.update({ where: { id: project.id }, data: { slug } });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    return {
      ok: false,
      code: "app_name_taken",
      reason: `"${slug}" is already taken. App addresses are unique across the whole platform.`,
    };
  }

  await repointShowcaseListings(project.id, previousSlug, slug);

  // Best-effort cleanup of anything a FAILED build left behind under the
  // old name — an empty data directory and any half-built images. Safe
  // only because assertNothingDeployed has already established there is
  // no Nomad job and no recorded deployment; with the name now freed,
  // nothing else would ever collect these (image retention and teardown
  // both filter by the app's current name, so they'd leak forever).
  // Best-effort in the same sense as every other internal call here: a
  // hostnsoft-deploy outage must not undo a slug change that already
  // committed.
  await tearDownApp(previousSlug);

  return { ok: true, project: updated, previousSlug, unchanged: false };
}
