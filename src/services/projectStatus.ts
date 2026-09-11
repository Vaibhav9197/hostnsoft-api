import { prisma } from "../lib/prisma";

// Shared by both project routes (list and get-one) so "what does status
// mean" can't drift between them — see projects.routes.ts. Always the
// CURRENT deployment's own status (via currentDeploymentId, not "most
// recent row by timestamp" — see deployments.routes.ts's isCurrent for
// why those can differ), never a stored column itself.
export const NO_DEPLOYMENTS_STATUS = "no_deployments";

export async function resolveProjectStatus(currentDeploymentId: string | null): Promise<string> {
  if (!currentDeploymentId) return NO_DEPLOYMENTS_STATUS;
  const deployment = await prisma.deployment.findUnique({
    where: { id: currentDeploymentId },
    select: { status: true },
  });
  return deployment?.status ?? NO_DEPLOYMENTS_STATUS;
}

// Batched — one query regardless of how many projects are passed in,
// rather than resolveProjectStatus() called once per project (an N+1
// this exists specifically to avoid on the list endpoint).
export async function resolveProjectStatuses(
  projects: { currentDeploymentId: string | null }[]
): Promise<Map<string, string>> {
  const ids = projects.map((p) => p.currentDeploymentId).filter((id): id is string => !!id);
  const deployments = await prisma.deployment.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  return new Map(deployments.map((d) => [d.id, d.status]));
}
