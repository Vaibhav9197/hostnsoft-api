import type { Prisma, Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { ORPHAN_CLEANUP_INTERVAL_MS, ORPHAN_TTL_MS } from "../lib/orphanConfig";
import { generateClaimCode } from "../lib/orphanClaim";
import { checkSlug, type SlugRejection } from "../lib/reservedSlugs";

// What the routes relay as a 409 — a reserved name (SlugRejection) or an
// expired orphan (expiredOrphanRejection below). They only read these two.
export type ClaimRejection = { reason: string; code: string };

export type ClaimResult =
  // adopted: this claim just moved a previously anonymous (orphan) app
  // into the caller's company.
  // claimCode: set only by claimOrphanProject, and only on the deploy that
  // CREATED the orphan — the one time the raw code exists outside its hash
  // (see lib/orphanClaim.ts). The route turns it into the claim link.
  | { project: Project; conflict: false; rejected: null; adopted?: boolean; claimCode?: string }
  | { project: null; conflict: true; rejected: null }
  | { project: null; conflict: false; rejected: ClaimRejection };

/**
 * An orphan whose 24 hours are up is frozen until orphan cleanup
 * (services/orphanCleanup.ts) removes it: no redeploy, adopt or claim
 * link may touch it. Cleanup decides what to delete from a list it reads
 * once per run, so an expired orphan that could still be adopted or
 * redeployed would have that new deploy — and, after an adopt, a
 * company's project — torn down and deleted along with it.
 *
 * Every write that takes an orphan over puts this in its own where, not
 * just in a check beforehand, so an orphan that expires between the read
 * and the write can't slip through either. A null expiry never expires
 * (cleanup's own query skips it too).
 */
export function unexpiredOrphanWhere(now: Date = new Date()): Prisma.ProjectWhereInput {
  return { isOrphan: true, OR: [{ orphanExpiresAt: null }, { orphanExpiresAt: { gt: now } }] };
}

function isExpiredOrphan(project: Project): boolean {
  return project.isOrphan && project.orphanExpiresAt !== null && project.orphanExpiresAt.getTime() <= Date.now();
}

// The name frees up once cleanup has run, so trying again later works —
// as a fresh app, without the expired one's data.
function expiredOrphanRejection(slug: string): ClaimRejection {
  const minutes = Math.ceil(ORPHAN_CLEANUP_INTERVAL_MS / 60_000);
  return {
    reason:
      `The temporary app "${slug}" has expired and is being removed, which takes up to ${minutes} minutes. ` +
      `Deploy again after that to start it fresh under this name, or deploy now under a different name.`,
    code: "app_expiring",
  };
}

/**
 * Reserved names are refused only when the slug isn't already a project.
 *
 * Enforcing them unconditionally would break every existing app whose name
 * happens to be on the list the moment this ships — a redeploy would start
 * failing on a name that was legal when it was claimed. Asking whether the
 * project exists first grandfathers those automatically, with no allowlist
 * to maintain: the name stays usable for as long as the app does, and
 * becomes unclaimable once it's deleted.
 */
async function slugRejection(slug: string): Promise<SlugRejection | null> {
  const check = checkSlug(slug);
  if (!check.reserved) return null;
  const existing = await prisma.project.findUnique({ where: { slug } });
  return existing ? null : check;
}

// Shared by the pre-deploy claim endpoint (internalProjects.routes.ts,
// called by hostnsoft-deploy BEFORE it spends any build/Nomad resources)
// and the post-deploy record endpoint (internalDeployments.routes.ts,
// kept as a defense-in-depth backstop for anyone calling record without
// having claimed first). hostnsoft-deploy only ever knows an app's slug
// (its X-App-Name — also the live subdomain), not this service's
// internal project id, so this resolves/creates by (companyId, slug).
//
// create-then-catch-conflict, not check-then-create: two deploys of a
// brand-new slug landing at nearly the same instant must not both see
// "no existing row" and both try to create one — same pattern used
// throughout this codebase (company creation in msg91Login.ts, deploy
// version allocation in internalDeployments.routes.ts).
//
// createdBy is the proxy userId when a real person deployed through the
// dashboard's upload UI (its proxy_auth_token names them — see
// services/deployActor.ts), and falls back to "hostnsoft-deploy" for a
// deploy token, which identifies a company but nobody in particular.
export async function claimProjectForCompany(
  companyId: string,
  slug: string,
  createdBy?: string | null
): Promise<ClaimResult> {
  const rejected = await slugRejection(slug);
  if (rejected) return { project: null, conflict: false, rejected };

  let project: Project;
  try {
    project = await prisma.project.create({
      data: { companyId, createdBy: createdBy ?? "hostnsoft-deploy", slug, name: slug },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    // Project already exists — true concurrent-create races are rare;
    // this branch mostly just means "this app has been deployed before,"
    // which is the normal case for every redeploy, so it isn't logged.
    project = await prisma.project.findUniqueOrThrow({ where: { slug } });
  }

  if (project.companyId === companyId) {
    return { project, conflict: false, rejected: null };
  }

  if (project.isOrphan) {
    // Adopt it — see docs/Anonymous-deploy-req.md #6. A previously
    // anonymous deploy is being claimed with a real token for the first
    // time: assign it to this company and clear every orphan field so it
    // behaves identically to a project that was always token-created.
    // claimCodeHash goes too: a claimed app has nothing left to claim, so
    // the link from the original deploy must stop working here as well.
    // Only while its 24 hours are still running — see unexpiredOrphanWhere.
    const moved = await prisma.project.updateMany({
      where: { id: project.id, ...unexpiredOrphanWhere() },
      data: { companyId, isOrphan: false, orphanExpiresAt: null, claimCodeHash: null },
    });
    if (moved.count === 0) {
      // Either it expired, or someone else took it over (the claim link,
      // another token) since the read above. Look again to say which.
      const current = await prisma.project.findUnique({ where: { id: project.id } });
      if (current && !current.isOrphan) {
        return current.companyId === companyId
          ? { project: current, conflict: false, rejected: null }
          : { project: null, conflict: true, rejected: null };
      }
      return { project: null, conflict: false, rejected: expiredOrphanRejection(slug) };
    }
    const adopted = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    return { project: adopted, conflict: false, rejected: null, adopted: true };
  }

  // Slug already belongs to a DIFFERENT, already-claimed company (slugs
  // are globally unique platform-wide — they're a live subdomain). This
  // is the actual "app name must be unique" enforcement point.
  return { project: null, conflict: true, rejected: null };
}

// The no-token path — see docs/Anonymous-deploy-req.md. Same create-
// then-catch-conflict shape as claimProjectForCompany above, but there's
// no company at all yet: a brand-new slug becomes a fresh orphan
// project; an already-orphan slug is simply reused (redeploying to the
// same anonymous session does NOT reset its expiry — the 24h clock
// starts once, at first creation); a slug already claimed by a real
// company is never touchable anonymously.
//
// A fresh orphan also gets its claim code here, in the same create: the
// code is the deployer's proof of ownership for the claim link, so it is
// handed back exactly once, to the deploy that brought the app into
// being. An anonymous redeploy of an existing orphan gets no code — the
// name alone must never be enough to obtain one, or anyone who guessed
// the name could claim the app out from under its deployer.
export async function claimOrphanProject(slug: string): Promise<ClaimResult> {
  const rejected = await slugRejection(slug);
  if (rejected) return { project: null, conflict: false, rejected };

  let project: Project;
  let claimCode: string | undefined;
  try {
    const claim = generateClaimCode();
    project = await prisma.project.create({
      data: {
        slug,
        name: slug,
        isOrphan: true,
        orphanExpiresAt: new Date(Date.now() + ORPHAN_TTL_MS),
        claimCodeHash: claim.hash,
      },
    });
    claimCode = claim.code;
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    project = await prisma.project.findUniqueOrThrow({ where: { slug } });
  }

  if (!project.isOrphan) {
    // Already claimed by a real company — an anonymous caller can never
    // take over or redeploy to it, even under its own name.
    return { project: null, conflict: true, rejected: null };
  }

  // Expired: refused, not reused — see unexpiredOrphanWhere. Nothing is
  // written here, so a deploy that gets past this just before expiry is
  // covered on hostnsoft-deploy's side instead: orphan cleanup skips any
  // app with a deploy in flight (tearDownApp's ifIdle).
  if (isExpiredOrphan(project)) {
    return { project: null, conflict: false, rejected: expiredOrphanRejection(slug) };
  }

  return { project, conflict: false, rejected: null, ...(claimCode ? { claimCode } : {}) };
}
