import { prisma } from "../lib/prisma";
import { can } from "../lib/permissions";

// May this person read this app's status and logs (app.logs)? For the two
// internal endpoints hostnsoft-deploy authorizes those reads through
// (internalTokens.routes.ts, internalProxyAuth.routes.ts). An app that
// isn't in the workspace is a plain no, as everywhere else.
export async function canReadApp(userId: string, companyId: string, appName: string): Promise<boolean> {
  const project = await prisma.project.findFirst({ where: { slug: appName, companyId }, select: { id: true } });
  return !!project && (await can(userId, companyId, "app.logs", project.id));
}
