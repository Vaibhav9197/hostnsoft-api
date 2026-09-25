/**
 * Changing an app's slug — the hostname it answers on, the Nomad job
 * name, and the X-App-Name an agent deploys with.
 *
 * Returns a tagged outcome rather than writing a response, same shape as
 * services/redeploy.ts: the route layer owns status codes.
 *
 * TWO PATHS, because the cost differs wildly. An app that has never
 * deployed exists nowhere but this database, so changing its slug is one
 * UPDATE. A deployed one exists on hostnsoft-deploy as a Nomad job,
 * Traefik routers, an image repository, a data directory and analytics
 * rows — all keyed by the slug, since there is no project id over there.
 * Moving those is a real migration with real downtime, delegated to that
 * service (services/appRename.ts) and recorded here only on success.
 *
 * The platform zone has no wildcard certificate: every app holds its own
 * single-name Let's Encrypt cert, so a live rename spends one from the
 * zone's weekly budget and takes as long as an ACME order. Hence the
 * cooldown, and why it applies only to the deployed path. DNS *is* a
 * wildcard, so neither path does DNS work.
 */
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { checkSlug } from "../lib/reservedSlugs";
import { envNumber } from "../lib/env";
import { fetchAppHealth } from "./appHealth";
import { tearDownApp } from "./appTeardown";
import { renameApp } from "./appRename";
import { platformAppUrl } from "./showcase";

/**
 * How long an app must wait between address changes, once it is live.
 *
 * Not an anti-abuse throttle so much as a budget guard: every live
 * rename orders a fresh Let's Encrypt certificate for the new hostname,
 * and that budget is per registered domain per week and shared with
 * every new app signing up. A week matches the shape of the limit it is
 * protecting. Only the deployed path consults it — an app that has never
 * deployed has no hostname in service and spends no certificate.
 */
export const SLUG_CHANGE_COOLDOWN_MS: number = envNumber(
  "SLUG_CHANGE_COOLDOWN_MS",
  7 * 24 * 60 * 60 * 1000
);

/**
 * Two actions, because only the live path spends a certificate and so
 * only it is subject to the cooldown. Under one action, renaming a
 * never-deployed app and then deploying it locked its address for a week
 * over a move that cost nothing.
 */
export const SLUG_CHANGE_AUDIT_ACTION = "project.slug_change";
export const SLUG_CHANGE_LIVE_AUDIT_ACTION = "project.slug_change_live";

/** For the readers that only care that it moved, not which path did it. */
export const SLUG_CHANGE_AUDIT_ACTIONS = [
  SLUG_CHANGE_AUDIT_ACTION,
  SLUG_CHANGE_LIVE_AUDIT_ACTION,
] as const;

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
  | "app_state_unknown"
  | "deploy_in_progress"
  | "slug_change_cooldown"
  | "no_current_deployment"
  | "rename_failed"
  // Raised only in the narrow case below: hostnsoft-deploy moved the app
  // but this service could not record it. Its own code, because it is
  // the one failure that needs a human rather than a retry.
  | "rename_desynced";

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
async function isLive(project: Project): Promise<boolean | "unknown"> {
  if (project.currentDeploymentId) return true;

  const health = await fetchAppHealth(project.slug);
  if (health === "not_deployed") return false;
  if (health === "unknown") return "unknown";

  // Running/starting/crashed/stopped with nothing recorded — the
  // failed-callback case above. Treat it as live, because it is.
  return true;
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

function takenReason(slug: string): string {
  return `"${slug}" is already taken. App addresses are unique across the whole platform.`;
}

/**
 * Milliseconds left on this app's cooldown, or 0 if it's free to move.
 *
 * Read from the audit log rather than a column on Project: the audit row
 * is already written for every slug change and is the authoritative
 * record of when one happened, so a dedicated timestamp would be a
 * second source of truth for the same fact — and one that a migration
 * would have to backfill.
 *
 * Only LIVE renames count: this guards the certificate budget, and a
 * database-only rename orders no certificate.
 */
export async function cooldownRemainingMs(projectId: string): Promise<number> {
  if (SLUG_CHANGE_COOLDOWN_MS <= 0) return 0;
  const last = await prisma.auditLog.findFirst({
    where: { projectId, action: SLUG_CHANGE_LIVE_AUDIT_ACTION },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return 0;
  const elapsed = Date.now() - last.createdAt.getTime();
  return Math.max(0, SLUG_CHANGE_COOLDOWN_MS - elapsed);
}

/**
 * The `details` of a slug-change audit row, written and read in one
 * place.
 *
 * Parsing structure out of a log field is grubby; a dedicated table was
 * rejected because the audit row is already the authoritative record of a
 * change, so a table would duplicate it. That holds only while nothing
 * outside this pair knows the format — both consumers (the cooldown, and
 * the lookups in slugChangeFlow.ts) go through them. Revisit the table if
 * a third consumer needs more than the two names.
 */
const SLUG_CHANGE_DETAIL_SEPARATOR = " -> ";

export function slugChangeDetails(from: string, to: string, note?: string): string {
  const base = `${from}${SLUG_CHANGE_DETAIL_SEPARATOR}${to}`;
  return note ? `${base} (${note})` : base;
}

export function parseSlugChangeDetails(details: string | null): { from: string; to: string } | null {
  if (!details) return null;
  // The optional "(agent:label)" suffix a non-dashboard caller appends
  // is not part of the pair, and a label could itself contain the
  // separator — so strip the suffix before splitting, not after.
  const withoutNote = details.replace(/\s*\([^)]*\)\s*$/, "");
  const at = withoutNote.indexOf(SLUG_CHANGE_DETAIL_SEPARATOR);
  if (at <= 0) return null;
  const from = withoutNote.slice(0, at).trim();
  const to = withoutNote.slice(at + SLUG_CHANGE_DETAIL_SEPARATOR.length).trim();
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Rewrite this project's recorded image tags from the old app name to
 * the new one, mirroring the `docker tag` pass hostnsoft-deploy just
 * did. Only the repository half changes; the version is untouched.
 */
async function retagDeploymentHistory(projectId: string, previousSlug: string, nextSlug: string): Promise<void> {
  const stale = await prisma.deployment.findMany({
    where: { projectId, imageTag: { startsWith: `${previousSlug}:` } },
    select: { id: true, imageTag: true },
  });
  for (const d of stale) {
    const version = d.imageTag!.slice(previousSlug.length + 1);
    await prisma.deployment.update({ where: { id: d.id }, data: { imageTag: `${nextSlug}:${version}` } });
  }
  if (stale.length) {
    logger.info(`[projectSlugChange] retagged ${stale.length} deployment record(s) from "${previousSlug}:*" to "${nextSlug}:*"`);
  }
}

/**
 * Everything that can be decided before anything changes: what the slug
 * normalises to, whether it is allowed, and which of the two paths this
 * app needs.
 *
 * Split from the work because the two paths answer differently: the cheap
 * path is one write and can be synchronous, while the migration takes
 * minutes (the dashboard proxy gives up at ten seconds), so the route must
 * validate, reply, then run it in the background — which it can only do if
 * the refusals are available separately from the work.
 */
export type SlugChangePlan =
  | { ok: true; slug: string; live: boolean; unchanged: boolean }
  | { ok: false; code: SlugChangeFailure; reason: string };

export async function prepareSlugChange(project: Project, requestedSlug: string): Promise<SlugChangePlan> {
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
    return { ok: true, slug, live: false, unchanged: true };
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

  const live = await isLive(project);
  if (live === "unknown") {
    return {
      ok: false,
      code: "app_state_unknown",
      reason:
        "Couldn't confirm whether this app is currently running, so its web " +
        "address wasn't changed. Try again in a moment.",
    };
  }

  if (!live) return { ok: true, slug, live: false, unchanged: false };

  // --- Remaining refusals apply only to a live app. ---
  const liveRefusal = await liveRefusals(project, slug);
  if (liveRefusal) return liveRefusal;
  return { ok: true, slug, live: true, unchanged: false };
}

/** The cheap path: nothing exists on hostnsoft-deploy under this name. */
export async function applyDatabaseOnlySlugChange(project: Project, slug: string): Promise<SlugChangeOutcome> {
  const previousSlug = project.slug;
  {
    // --- Nothing deployed: the slug exists only in this database.
    //
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
      return { ok: false, code: "app_name_taken", reason: takenReason(slug) };
    }

    await repointShowcaseListings(project.id, previousSlug, slug);

    // Best-effort cleanup of anything a FAILED build left behind under
    // the old name — an empty data directory and any half-built images.
    // Safe only because isLive has established there is no Nomad job and
    // no recorded deployment; with the name now freed, nothing else
    // would ever collect these (image retention and teardown both filter
    // by the app's current name, so they'd leak forever).
    await tearDownApp(previousSlug);

    return { ok: true, project: updated, previousSlug, unchanged: false };
  }
}

/** Refusals that only make sense for an app that is actually running. */
async function liveRefusals(
  project: Project,
  slug: string
): Promise<{ ok: false; code: SlugChangeFailure; reason: string } | null> {
  // Live, but we have no record of WHICH image is live — the
  // failed-callback case isLive catches. Rebuilding the job spec under a
  // new name needs that image tag, and guessing it would at best deploy
  // the wrong version and at worst deploy nothing. The cheap path is
  // equally wrong: it would rename the record and strand a running job
  // under the old name. Redeploying repairs the record, so say so.
  if (!project.currentDeploymentId) {
    return {
      ok: false,
      code: "no_current_deployment",
      reason:
        "This app is running, but there's no record of which version is live, so its address " +
        "can't be moved safely. Deploy it once and try again.",
    };
  }

  const inFlight = await prisma.deployment.findFirst({
    where: { projectId: project.id, status: "in_progress" },
  });
  if (inFlight) {
    // The migration stops the Nomad job partway through. A deploy
    // landing in that window would find the job stopped and
    // hostnsoft-deploy's purgeIfNotRunning would purge it out from under
    // the rollback path. Neither service has a cross-process lock, so
    // this check is the interlock — see rename-app.js's header.
    return {
      ok: false,
      code: "deploy_in_progress",
      reason: "A deploy is running for this app. Wait for it to finish, then change the address.",
    };
  }

  const cooldown = await cooldownRemainingMs(project.id);
  if (cooldown > 0) {
    const days = Math.ceil(cooldown / (24 * 60 * 60 * 1000));
    return {
      ok: false,
      code: "slug_change_cooldown",
      reason:
        `This app's address was changed recently. Each change needs a new security ` +
        `certificate, and those are rate-limited, so you can change it again in ${days} day${days === 1 ? "" : "s"}.`,
    };
  }

  // Pre-flight only. It cannot be authoritative: the migration below
  // takes minutes, and nothing reserves the name meanwhile. Claiming it
  // here first would be worse, not better — it would free the OLD name
  // for someone else during exactly the window in which the app is still
  // serving from it. So the real guard stays the unique constraint at
  // the end, and the (very narrow) loss of that race is reported as
  // rename_desynced rather than silently swallowed.
  if (await prisma.project.findUnique({ where: { slug } })) {
    return { ok: false, code: "app_name_taken", reason: takenReason(slug) };
  }

  return null;
}

/**
 * The expensive path: hand the running app to hostnsoft-deploy, then
 * record the move. Assumes prepareSlugChange has already approved it.
 */
export async function runSlugMigration(project: Project, slug: string): Promise<SlugChangeOutcome> {
  const previousSlug = project.slug;

  const moved = await renameApp(project, slug);
  if (!moved.renamed) {
    // hostnsoft-deploy rolls back before it answers, so the app is still
    // live under its old name here.
    return { ok: false, code: "rename_failed", reason: moved.error };
  }

  let updated: Project;
  try {
    updated = await prisma.project.update({ where: { id: project.id }, data: { slug } });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    // The app HAS moved and is serving the new address; we just can't
    // record it, because someone claimed the name during the migration.
    // Nothing here can fix that safely — moving the app back is another
    // full migration and another certificate — so it is logged loudly
    // and handed to a person.
    logger.error(
      `[projectSlugChange] DESYNC: hostnsoft-deploy moved project ${project.id} from "${previousSlug}" to ` +
        `"${slug}", but "${slug}" was claimed by another project during the migration. This service still ` +
        `records "${previousSlug}". The app is live at "${slug}" and needs manual reconciliation.`
    );
    return {
      ok: false,
      code: "rename_desynced",
      reason:
        `Your app has moved to "${slug}", but that address was claimed by someone else while the move was ` +
        `running, so we couldn't finish recording it. Support has been alerted.`,
    };
  }

  // Deployment.imageTag values embed the OLD app name ("<old>:<version>")
  // and hostnsoft-deploy retags every image to "<new>:<version>" and
  // drops the old tags. Left alone, every past deployment would point at
  // an image reference that no longer exists on the host, and rollback —
  // which replays exactly that string and checks it with `docker image
  // inspect` first — would fail with image_unavailable on all of them.
  await retagDeploymentHistory(project.id, previousSlug, slug);
  await repointShowcaseListings(project.id, previousSlug, slug);

  return { ok: true, project: updated, previousSlug, unchanged: false };
}
