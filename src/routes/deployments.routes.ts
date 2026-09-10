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

// One deployment, by id — what a rollback's 202 response's `statusUrl`
// points at, so a caller has something concrete to poll (`status`:
// "in_progress" | "success" | "failed") instead of re-fetching and
// re-scanning the full history list.
deploymentsRouter.get(
  "/companies/:companyId/projects/:projectId/deployments/:deploymentId",
  loadCompanyContext,
  loadProjectContext,
  async (req, res) => {
    const deployment = await prisma.deployment.findFirst({
      where: { id: req.params.deploymentId, projectId: req.project!.id },
    });
    if (!deployment) {
      return res.status(404).json({ error: "Deployment not found" });
    }
    res.json(deployment);
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
//
// Async, same shape as POST /apps: once the target image is CONFIRMED to
// exist (a fast, synchronous check — still fails fast with 422/502 below
// if it's gone), this responds 202 immediately rather than waiting for
// Nomad to actually apply the change, which can take a real, user-
// visible amount of time. The client polls `statusUrl` (this same
// deployment, GET .../deployments/:deploymentId) until `status` is no
// longer "in_progress" — hostnsoft-deploy reports the real outcome back
// via POST /internal/deployments/:deploymentId/complete once it knows it
// (see internalDeployments.routes.ts).
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

    // Created BEFORE the push call (status "in_progress", no finishedAt
    // yet) so there's something to poll immediately, and so
    // hostnsoft-deploy's async completion callback has a stable id to
    // report back against no matter how long the actual Nomad apply
    // takes. Deleted below if the push is never even accepted — no
    // "in progress" rollback should be left behind for a call that
    // failed before hostnsoft-deploy did anything.
    const deployment = await createDeploymentWithNextVersion(project.id, {
      appVersion: target.appVersion,
      imageTag: target.imageTag,
      memoryMb: effectiveMemoryMb,
      status: "in_progress",
      triggeredBy: `rollback:${req.userId}`,
    });

    const result = await pushAppConfig(project, {
      imageTag: target.imageTag,
      memoryMb: effectiveMemoryMb,
      customDomains: activeDomains.map((d) => d.domain),
      envVars,
      deploymentId: deployment.id,
    });
    if (!result.pushed) {
      await prisma.deployment.delete({ where: { id: deployment.id } });
      // hostnsoft-deploy only prunes images beyond its own retention
      // window (image-retention.js) — a target this old having no image
      // left on disk is an expected, user-actionable outcome, not a
      // platform failure, so this is a 422 telling the caller exactly
      // why and how far back rollback actually reaches, not a generic
      // 502 (which reads as "something's wrong with the service").
      if (result.code === "image_unavailable") {
        const retainCount = result.retainCount ?? 5;
        return res.status(422).json({
          error: `Cannot roll back: the image is no longer available. You can only roll back up to the last ${retainCount} deployments.`,
          code: "rollback_image_unavailable",
          retainCount,
        });
      }
      return res.status(502).json({ error: `Rollback failed: ${result.error}` });
    }

    await logAudit({
      actorUserId: req.userId,
      companyId: req.company!.id,
      projectId: project.id,
      action: "project.rollback",
      details: `to ${target.version} (${target.imageTag})`,
    });

    res.status(202).json({
      accepted: true,
      deploymentId: deployment.id,
      statusUrl: `/companies/${req.company!.id}/projects/${project.id}/deployments/${deployment.id}`,
      message:
        "Rollback started. Applying the previous version can take a little while — poll statusUrl until status is no longer \"in_progress\".",
    });
  }
);
