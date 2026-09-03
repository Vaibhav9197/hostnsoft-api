import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { findLiveDeployToken } from "../services/deployTokenAuth";
import { claimProjectForCompany } from "../services/projectClaim";

export const internalProjectsRouter = Router();

const claimSchema = z.object({
  token: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
});

// Called by hostnsoft-deploy BEFORE it spends any build/Nomad resources
// on a deploy — this is what actually enforces "app name (== live
// subdomain) must be unique platform-wide" at the only point that
// matters: before the Nomad job (named by that same app name) gets
// created, not after. The deploy token's own companyId identifies which
// company the project gets created under — a project never needs to
// exist via the dashboard first; this is the auto-create path for
// CLI/skill-first usage. No requireAuth — the deploy token itself is the
// credential, same trust shape as the other /internal/* endpoints.
internalProjectsRouter.post("/internal/projects/claim", async (req, res) => {
  const { token, slug } = claimSchema.parse(req.body);

  const tokenRecord = await findLiveDeployToken(token);
  if (!tokenRecord) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const result = await claimProjectForCompany(tokenRecord.companyId, slug);
  if (result.conflict) {
    return res.status(409).json({
      error: `App name "${slug}" is already in use by a different company`,
    });
  }

  // Include this project's already-active custom domains (see
  // docs/Customdomain-req.md) so every fresh deploy/rebuild regenerates
  // the job spec with their routers too — without this, a redeploy after
  // a custom domain was already active would silently drop it, since
  // hostnsoft-deploy has no persistent state of its own to remember it
  // by. This is the same call hostnsoft-deploy already makes on every
  // deploy, so no new integration point is needed for this to work.
  const activeDomains = await prisma.domain.findMany({
    where: { projectId: result.project.id, status: "active" },
    select: { domain: true },
  });

  res.json({
    projectId: result.project.id,
    slug: result.project.slug,
    memoryMb: result.project.memoryMb,
    customDomains: activeDomains.map((d) => d.domain),
  });
});
