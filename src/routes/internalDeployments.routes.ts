import { Router } from "express";
import { z } from "zod";
import { Prisma, type Deployment } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { findLiveDeployToken } from "../services/deployTokenAuth";

export const internalDeploymentsRouter = Router();

const recordSchema = z.object({
  companyId: z.string().min(1),
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

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Assigns this project's next sequential deploy number ("v1", "v2", ...)
// and creates the row atomically enough to survive two deploys of the
// same project landing at nearly the same moment: create-then-catch-
// conflict, same pattern as company creation in msg91Login.ts, rather
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
// requireAuth, the deploy token itself (re-checked here, independently of
// whatever check happened earlier in the same deploy request) is the
// credential, so this endpoint is trustworthy on its own rather than
// relying on the caller having already been authenticated once.
internalDeploymentsRouter.post("/internal/deployments/record", async (req, res) => {
  const body = recordSchema.parse(req.body);

  const tokenRecord = await findLiveDeployToken(body.companyId, body.token);
  if (!tokenRecord) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // hostnsoft-deploy only knows the app's slug (its X-App-Name), not this
  // service's internal project id — resolve/attach by (companyId, slug).
  // Auto-creates the Project row on first-ever deploy of a given slug
  // under this company, since real-world usage often deploys via the
  // skill/CLI before anyone has touched the dashboard — recording
  // deployment history should never silently fail just because nobody
  // clicked "create project" first.
  //
  // create-then-catch-conflict, not check-then-create: parallel CI jobs
  // can easily fire the very first deploy of a brand-new project at
  // nearly the same instant, and two concurrent finds both seeing no
  // existing row must not both try to create one and crash on the
  // resulting unique-constraint violation — same pattern as company
  // creation in msg91Login.ts.
  let project: Awaited<ReturnType<typeof prisma.project.findUnique>>;
  try {
    project = await prisma.project.create({
      data: { companyId: body.companyId, slug: body.projectSlug, name: body.projectSlug },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
    project = await prisma.project.findUniqueOrThrow({ where: { slug: body.projectSlug } });
  }

  if (project.companyId !== body.companyId) {
    // The slug is already claimed by a DIFFERENT company's project (slugs
    // are globally unique, since they're a live subdomain). Recording
    // this under the wrong company would be worse than not recording it.
    return res.status(409).json({
      error: `Project slug "${body.projectSlug}" belongs to a different company`,
    });
  }

  const deployment = await createDeploymentWithNextVersion(project.id, {
    appVersion: body.appVersion,
    imageTag: body.imageTag,
    memoryMb: body.memoryMb,
    status: body.status,
    errorDetail: body.errorDetail,
    triggeredBy: tokenRecord.label,
    finishedAt: new Date(),
  });

  res.status(201).json(deployment);
});
