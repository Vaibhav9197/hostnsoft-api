import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";

export const deploymentsRouter = Router();
deploymentsRouter.use(requireAuth);

// Populated by hostnsoft-deploy calling POST /internal/deployments/record
// after each deploy attempt concludes — see
// src/routes/internalDeployments.routes.ts.
deploymentsRouter.get(
  "/companies/:companyId/projects/:projectId/deployments",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const deployments = await prisma.deployment.findMany({
      where: { projectId: req.project!.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(deployments);
  }
);
