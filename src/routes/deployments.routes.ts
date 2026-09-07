import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { logAudit } from "../services/audit";
import { pushAppConfig } from "../services/customDomainActivation";
import { createDeploymentWithNextVersion } from "../services/deploymentVersioning";

export const deploymentsRouter = Router();
deploymentsRouter.use(requireProxyToken);

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

// One-click rollback — redeploys a past successful image with no
// rebuild, "pointer flip" style: reuses hostnsoft-deploy's config-push
// endpoint (see pushAppConfig), which applies a regenerated Nomad job
// spec in place without touching the build pipeline. Only the image
// changes — a rollback keeps the project's CURRENT domains and env vars
// exactly as they are today, since those are live configuration, not
// something tied to a specific past deploy. Recorded as a brand-new
// Deployment row with its own next version number, same as any other
// deploy, so the rollback itself shows up in history rather than
// silently rewriting it.
deploymentsRouter.post(
  "/companies/:companyId/projects/:projectId/deployments/:deploymentId/rollback",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const project = req.project!;

    const target = await prisma.deployment.findFirst({
      where: { id: req.params.deploymentId, projectId: project.id },
    });
    if (!target) {
      return res.status(404).json({ error: "Deployment not found" });
    }
    if (target.status !== "success" || !target.imageTag) {
      return res.status(422).json({ error: "Can only roll back to a past successful deployment that has an image" });
    }

    const activeDomains = await prisma.domain.findMany({
      where: { projectId: project.id, status: "active" },
      select: { domain: true },
    });
    const envVars = await prisma.envVar.findMany({
      where: { projectId: project.id },
      select: { key: true, value: true },
    });

    // The memory floor this specific past image actually needs (e.g. an
    // embedded-DB dependency present at that version) isn't necessarily
    // today's floor if dependencies changed since — same Math.max
    // reasoning as customDomainActivation.ts, just floored against the
    // TARGET deployment's own recorded memory instead of the latest one.
    const effectiveMemoryMb = Math.max(project.memoryMb, target.memoryMb ?? 0);

    const result = await pushAppConfig(project, {
      imageTag: target.imageTag,
      memoryMb: effectiveMemoryMb,
      customDomains: activeDomains.map((d) => d.domain),
      envVars,
    });
    if (!result.pushed) {
      return res.status(502).json({ error: `Rollback failed: ${result.error}` });
    }

    const deployment = await createDeploymentWithNextVersion(project.id, {
      appVersion: target.appVersion,
      imageTag: target.imageTag,
      memoryMb: effectiveMemoryMb,
      status: "success",
      triggeredBy: `rollback:${req.userId}`,
      finishedAt: new Date(),
    });

    if (effectiveMemoryMb > project.memoryMb) {
      await prisma.project.update({ where: { id: project.id }, data: { memoryMb: effectiveMemoryMb } });
    }

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: project.id,
      action: "project.rollback",
      details: `to ${target.version} (${target.imageTag})`,
    });

    res.status(201).json(deployment);
  }
);
