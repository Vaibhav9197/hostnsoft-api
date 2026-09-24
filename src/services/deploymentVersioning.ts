import { Prisma, type Deployment } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { logger } from "../lib/logger";

// Assigns this project's next sequential deploy number ("v1", "v2", ...)
// and creates the row atomically enough to survive two deploys of the
// same project landing at nearly the same moment: create-then-catch-
// conflict, same pattern as project claiming in
// src/services/projectClaim.ts, rather than trusting a count() read is
// still accurate by the time create() runs. Shared by
// internalDeployments.routes.ts (a real build/deploy attempt) and
// deployments.routes.ts's rollback endpoint (redeploying a past image
// with no rebuild) — a rollback is still a new deploy event and gets its
// own version number, same as any other deploy.
export async function createDeploymentWithNextVersion(
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

// Shared by internalDeployments.routes.ts's two success paths (a normal
// deploy's /internal/deployments/record call, and a rollback's async
// /internal/deployments/:id/complete callback) — both need the exact
// same "this is now the live version" bookkeeping. See
// Project.currentDeploymentId's own schema comment for why this is a
// plain field rather than something derived by query each time.
export type DeployKind = "static" | "service";

export async function markProjectDeploymentLive(
  projectId: string,
  deploymentId: string,
  appliedMemoryMb: number | null | undefined,
  currentProjectMemoryMb: number,
  // What hostnsoft-deploy actually deployed this time — see
  // Project.kind's schema comment. Omitted when the caller can't know
  // (a rollback's /complete callback redeploys a past image and never
  // changes the app's kind), in which case the column is left alone.
  kind?: DeployKind
): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: {
      currentDeploymentId: deploymentId,
      ...(kind ? { kind } : {}),
      // Never downward — see internalDeployments.routes.ts's original
      // comment on this exact reasoning (an explicit higher configured
      // value must never be undercut by a lower auto-detected one).
      ...(typeof appliedMemoryMb === "number" && appliedMemoryMb > currentProjectMemoryMb
        ? { memoryMb: appliedMemoryMb }
        : {}),
    },
  });
}
