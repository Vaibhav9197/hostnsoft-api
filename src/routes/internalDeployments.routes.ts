import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { findLiveDeployToken } from "../services/deployTokenAuth";
import { claimProjectForCompany } from "../services/projectClaim";
import { createDeploymentWithNextVersion } from "../services/deploymentVersioning";

export const internalDeploymentsRouter = Router();

const recordSchema = z.object({
  token: z.string().min(1),
  projectSlug: z.string().min(1),
  // Whatever hostnsoft-deploy used for the image tag (X-App-Version, or
  // its own timestamp fallback) — NOT the deployment's identity. A user
  // can redeploy without bumping this at all; see schema.prisma.
  appVersion: z.string().min(1),
  // "in_progress" — the build/deploy now runs in the background after
  // the upload response is already sent (avoiding a proxy timeout on a
  // slow build), so a deployment attempt is recorded the moment it
  // STARTS, not only once it concludes, and the same row is later
  // updated in place (see deploymentId below) rather than a second row
  // being created.
  status: z.enum(["in_progress", "success", "failed"]),
  imageTag: z.string().optional(),
  memoryMb: z.number().int().optional(),
  errorDetail: z.string().optional(),
  // If set, updates this existing row (must belong to the resolved
  // project) instead of allocating a new version — the second call for a
  // given deploy attempt (transitioning in_progress -> success/failed),
  // as opposed to the first call that created it.
  deploymentId: z.string().min(1).optional(),
});

// Called by hostnsoft-deploy (server-to-server) once a deploy attempt has
// concluded, success or failure — this is what actually populates the
// deployment history GET /companies/:companyId/projects/:projectId/deployments
// reads. Same auth shape as /internal/deploy-tokens/validate: no
// requireProxyToken, the deploy token itself (re-checked here, independently of
// whatever check happened earlier in the same deploy request) is the
// credential, so this endpoint is trustworthy on its own rather than
// relying on the caller having already been authenticated once. The
// token's own companyId is the source of truth for which company this
// deployment belongs to.
//
// Project resolution here is a defense-in-depth backstop, not the
// primary enforcement point — hostnsoft-deploy is expected to have
// already called POST /internal/projects/claim before ever building, so
// the "wrong company" conflict below should be close to unreachable in
// practice. Shares claimProjectForCompany with that endpoint rather than
// duplicating the create-then-catch-conflict logic.
internalDeploymentsRouter.post("/internal/deployments/record", async (req, res) => {
  const body = recordSchema.parse(req.body);

  const tokenRecord = await findLiveDeployToken(body.token);
  if (!tokenRecord) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const claim = await claimProjectForCompany(tokenRecord.companyId, body.projectSlug);
  if (claim.conflict) {
    return res.status(409).json({
      error: `Project slug "${body.projectSlug}" belongs to a different company`,
    });
  }

  // finishedAt stays null while in_progress — set the moment the
  // attempt actually concludes, on whichever call (create or update)
  // that turns out to be.
  const finishedAt = body.status === "in_progress" ? null : new Date();

  let deployment;
  if (body.deploymentId) {
    const existing = await prisma.deployment.findFirst({
      where: { id: body.deploymentId, projectId: claim.project.id },
    });
    if (!existing) {
      return res.status(404).json({ error: "Deployment not found" });
    }
    deployment = await prisma.deployment.update({
      where: { id: existing.id },
      data: {
        status: body.status,
        imageTag: body.imageTag,
        memoryMb: body.memoryMb,
        errorDetail: body.errorDetail,
        finishedAt,
      },
    });
  } else {
    deployment = await createDeploymentWithNextVersion(claim.project.id, {
      appVersion: body.appVersion,
      imageTag: body.imageTag,
      memoryMb: body.memoryMb,
      status: body.status,
      errorDetail: body.errorDetail,
      triggeredBy: tokenRecord.label,
      finishedAt,
    });
  }

  // body.memoryMb here is hostnsoft-deploy's actual applied taskMemory —
  // already floor-adjusted for embedded-DB apps (see server.js's
  // Math.max(autoDetectedMemory, ...)). Project.memoryMb previously only
  // ever changed via the explicit PATCH .../memory endpoint, so an
  // embedded-DB app that never touched that setting stayed stuck at the
  // schema default (256) in the DB forever despite actually running at
  // 512 — which customDomainActivation.ts's pushCustomDomainConfig would
  // then read as gospel and use to shrink the running app back down.
  // Persisting the real applied value here (never downward — an
  // explicit higher configured value must never be undercut by a lower
  // auto-detected one) keeps Project.memoryMb a source of truth instead
  // of a stale default.
  if (body.status === "success" && typeof body.memoryMb === "number" && body.memoryMb > claim.project.memoryMb) {
    await prisma.project.update({
      where: { id: claim.project.id },
      data: { memoryMb: body.memoryMb },
    });
  }

  res.status(201).json(deployment);
});
