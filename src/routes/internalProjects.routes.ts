import { Router } from "express";
import { z } from "zod";
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

  res.json({
    projectId: result.project.id,
    slug: result.project.slug,
    memoryMb: result.project.memoryMb,
  });
});
