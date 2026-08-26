import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { loadCompanyContext } from "../middleware/companyContext";

export const deploymentsRouter = Router();
deploymentsRouter.use(requireAuth);

deploymentsRouter.get(
  "/companies/:companyId/projects/:projectId/deployments",
  loadCompanyContext,
  async (req, res) => {
    const deployments = await prisma.deployment.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { createdAt: "desc" },
    });
    res.json(deployments);
  }
);

const recordDeploymentSchema = z.object({
  version: z.string().min(1),
  imageTag: z.string().optional(),
  memoryMb: z.number().int().optional(),
  status: z.enum(["success", "failed", "in_progress"]),
  errorDetail: z.string().optional(),
  triggeredBy: z.string().optional(),
});

// TODO: not yet wired to anything real. hostnsoft-deploy has no callback/
// webhook today, so nothing calls this yet — how a deploy's outcome
// actually reaches this table (poll vs. webhook from hostnsoft-deploy) is
// an open integration question, not decided here. This exists so the
// Deployment history read path has something to query against.
deploymentsRouter.post(
  "/companies/:companyId/projects/:projectId/deployments/record",
  loadCompanyContext,
  async (req, res) => {
    const body = recordDeploymentSchema.parse(req.body);
    const deployment = await prisma.deployment.create({
      data: { projectId: req.params.projectId, ...body },
    });
    res.status(201).json(deployment);
  }
);
