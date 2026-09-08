import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { findLiveDeployToken } from "../services/deployTokenAuth";
import { claimProjectForCompany, claimOrphanProject } from "../services/projectClaim";
import { buildOrphanMessage, ORPHAN_LOGIN_URL } from "../lib/orphanMessage";

export const internalProjectsRouter = Router();

// token is now optional — see docs/Anonymous-deploy-req.md. Absent
// entirely means "deploy anonymously"; hostnsoft-deploy only omits it
// when the incoming deploy request itself carried no Authorization
// header at all (an invalid/malformed token it still sends here so this
// endpoint's normal 401 applies — anonymous is opt-in by omission only,
// never a fallback for a failed auth attempt).
const claimSchema = z.object({
  token: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
});

// Called by hostnsoft-deploy BEFORE it spends any build/Nomad resources
// on a deploy — this is what actually enforces "app name (== live
// subdomain) must be unique platform-wide" at the only point that
// matters: before the Nomad job (named by that same app name) gets
// created, not after. The deploy token's own companyId identifies which
// company the project gets created under — a project never needs to
// exist via the dashboard first; this is the auto-create path for
// CLI/skill-first usage. No requireProxyToken — the deploy token itself is the
// credential, same trust shape as the other /internal/* endpoints.
internalProjectsRouter.post("/internal/projects/claim", async (req, res) => {
  const { token, slug } = claimSchema.parse(req.body);

  const result = token
    ? await (async () => {
        const tokenRecord = await findLiveDeployToken(token);
        if (!tokenRecord) return { unauthorized: true as const };
        return { unauthorized: false as const, claim: await claimProjectForCompany(tokenRecord.companyId, slug) };
      })()
    : { unauthorized: false as const, claim: await claimOrphanProject(slug) };

  if (result.unauthorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (result.claim.conflict) {
    return res.status(409).json({
      error: `App name "${slug}" is already in use by a different company`,
    });
  }

  const { project } = result.claim;

  // Include this project's already-active custom domains (see
  // docs/Customdomain-req.md) so every fresh deploy/rebuild regenerates
  // the job spec with their routers too — without this, a redeploy after
  // a custom domain was already active would silently drop it, since
  // hostnsoft-deploy has no persistent state of its own to remember it
  // by. This is the same call hostnsoft-deploy already makes on every
  // deploy, so no new integration point is needed for this to work.
  const activeDomains = await prisma.domain.findMany({
    where: { projectId: project.id, status: "active" },
    select: { domain: true },
  });

  // This project's configured env vars (see envVars.routes.ts) — sent on
  // every deploy so hostnsoft-deploy can bake them into the container's
  // env block. Previously set here but never actually reached the
  // running app (see docs/CLAUDE.md's known gaps); this is that missing
  // integration point. An orphan project can never have any (env vars
  // are only ever set through the company-scoped route, which requires
  // an already-claimed project), so this naturally comes back empty for
  // anonymous deploys without any special-casing.
  const envVars = await prisma.envVar.findMany({
    where: { projectId: project.id },
    select: { key: true, value: true },
  });

  res.json({
    projectId: project.id,
    slug: project.slug,
    memoryMb: project.memoryMb,
    customDomains: activeDomains.map((d) => d.domain),
    envVars,
    // Orphan fields — see docs/Anonymous-deploy-req.md. isOrphan is
    // always present; the other two are only meaningful (and only sent)
    // when it's true, so hostnsoft-deploy can check one field to decide
    // whether to inject the banner and include `orphan` in its response.
    isOrphan: project.isOrphan,
    ...(project.isOrphan && project.orphanExpiresAt
      ? {
          orphanExpiresAt: project.orphanExpiresAt.toISOString(),
          orphanMessage: buildOrphanMessage(project.orphanExpiresAt),
          orphanLoginUrl: ORPHAN_LOGIN_URL,
        }
      : {}),
  });
});

const lookupSchema = z.object({ slug: z.string().min(1).regex(/^[a-z0-9-]+$/) });

// Read-only — unlike POST .../claim above, this never creates or adopts
// a project. Backs hostnsoft-deploy's GET /apps/:appName/status and
// .../logs, which need to know "does this app exist, is it orphan, and
// which company owns it" to authorize the request, WITHOUT the side
// effect claiming would have (silently adopting an orphan into the
// caller's company, or creating a phantom project row for a
// never-deployed/mistyped app name, just from checking its status).
internalProjectsRouter.post("/internal/projects/lookup", async (req, res) => {
  const { slug } = lookupSchema.parse(req.body);
  const project = await prisma.project.findUnique({ where: { slug } });
  if (!project) {
    return res.json({ exists: false });
  }
  res.json({ exists: true, companyId: project.companyId, isOrphan: project.isOrphan });
});
