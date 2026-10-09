import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { pushCustomDomainConfig } from "./customDomainActivation";

// The footer decision (free plan or not) is baked into each app's job
// spec when hostnsoft-deploy generates it, so a plan change on its own
// does nothing to running apps: an upgraded company keeps the footer
// until it happens to redeploy. This re-pushes every deployed app of
// the company so the spec is regenerated against the plan as it is now.
//
// Best-effort and detached from the request that triggered it — each
// push is a Nomad apply that can take seconds per app, and a plan change
// must succeed in Lago whether or not this follow-up does.
export function resyncCompanyFooters(companyId: string, reason: string): void {
    void (async () => {
        const projects = await prisma.project.findMany({
            where: { companyId, currentDeploymentId: { not: null } },
            select: { id: true, slug: true },
        });

        for (const project of projects) {
            const result = await pushCustomDomainConfig(project.id);
            if (!result.pushed) {
                logger.warn(`[footerResync] ${project.slug}: push failed after ${reason}: ${result.error}`);
            }
        }
        logger.info(`[footerResync] company ${companyId}: resynced ${projects.length} app(s) after ${reason}`);
    })().catch((e) => {
        logger.error(`[footerResync] company ${companyId} failed after ${reason}: ${(e as Error).message}`);
    });
}
