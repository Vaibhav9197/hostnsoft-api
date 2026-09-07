import { Router } from "express";
import { z } from "zod";
import { Prisma, type Deployment } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { findLiveDeployToken } from "../services/deployTokenAuth";
import { claimProjectForCompany } from "../services/projectClaim";
import { logger } from "../lib/logger";

export const internalDeploymentsRouter = Router();

const recordSchema = z.object({
  token: z.string().min(1),
  projectSlug: z.string().min(1),
  // Whatever hostnsoft-deploy used for the image tag (X-App-Version, or
  // its own timestamp fallback) — NOT the deployment's identity. A user
  // can redeploy without bumping this at all; see schema.prisma.
  appVersion: z.string().min(1),
  status: z.enum(["success", "failed"]),
  imageTag: z.string().optional(),
  memoryMb: z.number().int().optional(),
  errorDetail: z.string().optional(),
});

// Assigns this project's next sequential deploy number ("v1", "v2", ...)
// and creates the row atomically enough to survive two deploys of the
// same project landing at nearly the same moment: create-then-catch-
// conflict, same pattern as project claiming in src/services/projectClaim.ts, rather
// than trusting a count() read is still accurate by the time create()
// runs.
async function createDeploymentWithNextVersion(
  projectId: string,
  data: Omit<Prisma.DeploymentCreateInput, "version" | "project">
): Promise<Deployment> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existingCount = await prisma.deployment.count({ where: { projectId } });
    const version = `v${existingCount + 1}`;
    try {
      return await prisma.deployment.create({
        data: { ...data, version, project: { connect: { id: projectId } } },
      });
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) throw err;
      // Another deploy for this project claimed that version number
      // between our count() and create() — recompute and retry.
      logger.info(
        `[createDeploymentWithNextVersion] lost the race for ${version} on project ${projectId} (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — retrying`
      );
    }
  }
  throw new Error(
    `Could not allocate a unique deployment version for project ${projectId} after ${MAX_ATTEMPTS} attempts`
  );
}

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

  const deployment = await createDeploymentWithNextVersion(claim.project.id, {
    appVersion: body.appVersion,
    imageTag: body.imageTag,
    memoryMb: body.memoryMb,
    status: body.status,
    errorDetail: body.errorDetail,
    triggeredBy: tokenRecord.label,
    finishedAt: new Date(),
  });

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
