import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { ORPHAN_TTL_MS } from "../lib/orphanConfig";

export type ClaimResult =
  | { project: Project; conflict: false }
  | { project: null; conflict: true };

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
export async function claimProjectForCompany(
  companyId: string,
  slug: string
): Promise<ClaimResult> {
  let project: Project;
  try {
    project = await prisma.project.create({
      data: { companyId, slug, name: slug },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    // Project already exists — true concurrent-create races are rare;
    // this branch mostly just means "this app has been deployed before,"
    // which is the normal case for every redeploy, so it isn't logged.
    project = await prisma.project.findUniqueOrThrow({ where: { slug } });
  }

  if (project.companyId === companyId) {
    return { project, conflict: false };
  }

  if (project.isOrphan) {
    // Adopt it — see docs/Anonymous-deploy-req.md #6. A previously
    // anonymous deploy is being claimed with a real token for the first
    // time: assign it to this company and clear every orphan field so it
    // behaves identically to a project that was always token-created.
    const adopted = await prisma.project.update({
      where: { id: project.id },
      data: { companyId, isOrphan: false, orphanExpiresAt: null },
    });
    return { project: adopted, conflict: false };
  }

  // Slug already belongs to a DIFFERENT, already-claimed company (slugs
  // are globally unique platform-wide — they're a live subdomain). This
  // is the actual "app name must be unique" enforcement point.
  return { project: null, conflict: true };
}

// The no-token path — see docs/Anonymous-deploy-req.md. Same create-
// then-catch-conflict shape as claimProjectForCompany above, but there's
// no company at all yet: a brand-new slug becomes a fresh orphan
// project; an already-orphan slug is simply reused (redeploying to the
// same anonymous session does NOT reset its expiry — the 24h clock
// starts once, at first creation); a slug already claimed by a real
// company is never touchable anonymously.
export async function claimOrphanProject(slug: string): Promise<ClaimResult> {
  let project: Project;
  try {
    project = await prisma.project.create({
      data: {
        slug,
        name: slug,
        isOrphan: true,
        orphanExpiresAt: new Date(Date.now() + ORPHAN_TTL_MS),
      },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    project = await prisma.project.findUniqueOrThrow({ where: { slug } });
  }

  if (!project.isOrphan) {
    // Already claimed by a real company — an anonymous caller can never
    // take over or redeploy to it, even under its own name.
    return { project: null, conflict: true };
  }

  return { project, conflict: false };
}
