import type { Prisma, Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { ORPHAN_CLEANUP_INTERVAL_MS, ORPHAN_TTL_MS } from "../lib/orphanConfig";
import { generateClaimCode } from "../lib/orphanClaim";
import { checkSlug, type SlugRejection } from "../lib/reservedSlugs";
import { findRenamedApp } from "./slugChangeFlow";
import { checkAppAccess, createRefusal, type AccessActor, type AccessRefusal, type MovedNotice } from "./tokenAccess";

// What the routes relay as an error — a reserved name (SlugRejection), an
// expired orphan (expiredOrphanRejection below), or an app id that no
// longer leads anywhere (resolveDeployTarget). `status` defaults to 409.
export type ClaimRejection = { reason: string; code: string; status?: number };

// Something that changed outside this deploy that the deployer should
// know, e.g. the app was renamed in the dashboard. Relayed in the deploy
// reply's notices[].
// app_moved: the app is now in a different workspace (tokenAccess.ts
// movedNotice) — from/to are workspace names, present only for a caller in
// both.
export type DeployNotice =
  | { code: "app_renamed"; from: string; to: string; detail: string }
  | MovedNotice;

export type ClaimResult =
  // adopted: this claim just moved a previously anonymous (orphan) app
  // into the caller's company.
  // created: this claim made the project — the deploy reply's
  // action: "created", so a caller that expected an existing app notices.
  // claimCode: set only by claimOrphanProject, and only on the deploy that
  // CREATED the orphan — the one time the raw code exists outside its hash
  // (see lib/orphanClaim.ts). The route turns it into the claim link.
  | {
    project: Project;
    conflict: false;
    rejected: null;
    adopted?: boolean;
    created?: boolean;
    claimCode?: string;
    notices?: DeployNotice[];
  }
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

// An app's old name stays its own (schema.prisma SlugAlias), so a new app
// can't be created under it. The owner's own deploys under it never get
// here: resolveDeployTarget sends them to the renamed app first.
async function isOtherAppsOldName(slug: string): Promise<boolean> {
  return (await prisma.slugAlias.findUnique({ where: { slug } })) !== null;
}

function renamedNotice(from: string, to: string): DeployNotice {
  return {
    code: "app_renamed",
    from,
    to,
    detail:
      `This app was renamed from "${from}" to "${to}" outside this deploy, so this deploy updated "${to}". ` +
      `Use "${to}" as the app name from now on.`,
  };
}

/**
 * Which app a deploy goes to. The deployer sends the app name
 * (X-App-Name) and, after its first deploy, the app's id (X-App-Id, kept in
 * the app's embarko.json). The id wins: the name can be changed from the
 * dashboard without the deployer knowing, and before this a deploy under
 * the old name created a second app.
 *
 * - id given: deploy to that app whatever it is called now. An id that
 *   leads nowhere is refused rather than replaced by a new app, so a
 *   deleted app is never recreated by accident.
 * - no id: the app with that name, then the app that used to have it
 *   (findRenamedApp), and only then a new app.
 *
 * Which existing apps the caller may reach is tokenAccess.ts's decision
 * (`actor`, added with user tokens 2026-10-21): a workspace token or a
 * dashboard upload reaches its own workspace's apps, exactly as before; a
 * user token reaches any app its person may deploy, in any workspace, and
 * creates new apps in its default workspace (`companyId`) — only if its
 * person may still create apps there. Leaving `actor` out means "workspace
 * kind for companyId", which is every caller's behaviour before this.
 *
 * An app that moved to another workspace is never re-created under the
 * caller's: a caller that used to reach it is refused with app_moved, and a
 * stranger gets the same app_not_found / app_name_taken as always.
 */
export async function resolveDeployTarget(
  companyId: string,
  slug: string,
  appId: string | undefined,
  createdBy?: string | null,
  actor?: AccessActor
): Promise<ClaimResult> {
  const who: AccessActor = actor ?? { kind: "workspace", companyId, userId: createdBy ?? null };
  const refuse = (r: AccessRefusal): ClaimResult => ({
    project: null,
    conflict: false,
    rejected: { status: r.status, code: r.code, reason: r.reason },
  });

  if (appId) {
    const project = await prisma.project.findUnique({ where: { id: appId } });

    // An orphan has no owner yet, so its id gets the same adopt path its
    // name does.
    if (project?.isOrphan) {
      const denied = await createRefusal(who);
      if (denied) return refuse(denied);
      const claim = await claimProjectForCompany(companyId, project.slug, createdBy);
      if (claim.project && project.slug !== slug) claim.notices = [renamedNotice(slug, project.slug)];
      return claim;
    }

    if (project) {
      const access = await checkAppAccess(who, project, "app.deploy", { notice: true, appName: slug });
      if (access.ok) {
        const notices: DeployNotice[] = [];
        if (project.slug !== slug) notices.push(renamedNotice(slug, project.slug));
        if (access.notice) notices.push(access.notice);
        return { project, conflict: false, rejected: null, notices: notices.length ? notices : undefined };
      }
      if (access.refusal) return refuse(access.refusal);
    }

    // Another company's app answers the same as no app: an id is not
    // access control, but it must not confirm the app exists either.
    const deleted = await prisma.auditLog.findFirst({
      where: { projectId: appId, companyId, action: "project.delete" },
      select: { id: true },
    });
    return {
      project: null,
      conflict: false,
      rejected: deleted
        ? {
          status: 410,
          code: "app_deleted",
          reason:
            `The app with id "${appId}" was deleted. Ask the user before deploying it again: ` +
            `to create it as a new app, remove "appId" from embarko.json and deploy.`,
        }
        : {
          status: 404,
          code: "app_not_found",
          reason:
            `No app with id "${appId}" that this token can reach. Check embarko.json's "appId" ` +
            `belongs to this token's workspace (or, for a personal token, to one its person is in), or remove it to deploy as a new app.`,
        },
    };
  }

  // By name. Names are unique platform-wide, current (Project.slug) and old
  // (SlugAlias), so this finds the one app the name can mean, in whichever
  // workspace — then asks whether this caller may deploy it.
  const named = await prisma.project.findUnique({ where: { slug } });
  if (named && !named.isOrphan) {
    const access = await checkAppAccess(who, named, "app.deploy", { notice: true, appName: slug });
    if (access.ok) {
      return { project: named, conflict: false, rejected: null, notices: access.notice ? [access.notice] : undefined };
    }
    if (access.refusal) return refuse(access.refusal);
    // Someone else's app: the claim below reports it as taken, as always.
  }

  if (!named) {
    const alias = await prisma.slugAlias.findUnique({ where: { slug }, include: { project: true } });
    if (alias && !alias.project.isOrphan) {
      const access = await checkAppAccess(who, alias.project, "app.deploy", { notice: true, appName: slug });
      if (access.ok) {
        const notices: DeployNotice[] = [renamedNotice(slug, alias.project.slug)];
        if (access.notice) notices.push(access.notice);
        return { project: alias.project, conflict: false, rejected: null, notices };
      }
      if (access.refusal) return refuse(access.refusal);
    }

    // A rename still finishing, or one older than SlugAlias — both only
    // within the caller's own workspace (findRenamedApp is company-scoped).
    const renamed = await findRenamedApp(companyId, slug);
    if (renamed) {
      const access = await checkAppAccess(who, renamed.project, "app.deploy", { notice: true, appName: slug });
      if (access.ok) {
        return { project: renamed.project, conflict: false, rejected: null, notices: [renamedNotice(slug, renamed.to)] };
      }
      if (access.refusal) return refuse(access.refusal);
    }

    // About to create (or adopt): the one step a user token needs app.create
    // for. Checked only now, so deploying an existing app never needs it.
    const denied = await createRefusal(who);
    if (denied) return refuse(denied);
  } else if (named.isOrphan) {
    const denied = await createRefusal(who);
    if (denied) return refuse(denied);
  }

  return claimProjectForCompany(companyId, slug, createdBy);
}

/**
 * Which of the company's own apps a deploy would land on, WITHOUT creating
 * or adopting anything — the same lookups as resolveDeployTarget's
 * non-creating branches, in the same order. The claim endpoint asks this
 * first so it can check the right permission before anything is written:
 * app.deploy on the app it finds, or app.create when it finds none (a
 * brand-new name, or an orphan being adopted — both make the workspace a
 * new app). Null also covers names that will be refused anyway (another
 * workspace's, reserved, a dead id); those still get their own error from
 * resolveDeployTarget, after an app.create check that a member who can't
 * add apps fails first.
 */
export async function peekDeployTarget(companyId: string, slug: string, appId: string | undefined): Promise<Project | null> {
  if (appId) {
    const project = await prisma.project.findUnique({ where: { id: appId } });
    return project && !project.isOrphan && project.companyId === companyId ? project : null;
  }
  const own = await prisma.project.findFirst({ where: { slug, companyId } });
  if (own) return own;
  return (await findRenamedApp(companyId, slug))?.project ?? null;
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
// createdBy is the person behind the deploy: the signed-in user for the
// dashboard's upload UI, or the deploy token's creator (services/
// deployActor.ts actorPersonId) — since roles, that's who a Developer's
// "may always delete apps they created" and "selected apps include the ones
// they made" key on (lib/permissions.ts). "hostnsoft-deploy" remains only
// for callers that name nobody, and on apps created before this.
export async function claimProjectForCompany(
  companyId: string,
  slug: string,
  createdBy?: string | null
): Promise<ClaimResult> {
  const rejected = await slugRejection(slug);
  if (rejected) return { project: null, conflict: false, rejected };
  if (await isOtherAppsOldName(slug)) return { project: null, conflict: true, rejected: null };

  let project: Project;
  let created = false;
  try {
    project = await prisma.project.create({
      data: { companyId, createdBy: createdBy ?? "hostnsoft-deploy", slug, name: slug },
    });
    created = true;
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    // Project already exists — true concurrent-create races are rare;
    // this branch mostly just means "this app has been deployed before,"
    // which is the normal case for every redeploy, so it isn't logged.
    project = await prisma.project.findUniqueOrThrow({ where: { slug } });
  }

  if (project.companyId === companyId) {
    return { project, conflict: false, rejected: null, created };
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
      // createdBy too: an orphan has none, and the person adopting it is
      // the one who made it this workspace's app.
      data: { companyId, isOrphan: false, orphanExpiresAt: null, claimCodeHash: null, ...(createdBy ? { createdBy } : {}) },
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
  if (await isOtherAppsOldName(slug)) return { project: null, conflict: true, rejected: null };

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
