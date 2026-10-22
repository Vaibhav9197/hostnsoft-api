import { prisma } from "../lib/prisma";
import { can, type Permission } from "../lib/permissions";

// May this person read this app's status (app.view) or logs (app.logs)?
// For the endpoint hostnsoft-deploy authorizes dashboard reads through
// (internalProxyAuth.routes.ts). An app that
// isn't in the workspace is a plain no, as everywhere else. The caller
// must have just confirmed membership with proxy itself, so this doesn't
// ask again — status and logs are polled.
export async function canReadApp(
  userId: string,
  companyId: string,
  appName: string,
  permission: Extract<Permission, "app.view" | "app.logs">
): Promise<boolean> {
  const project = await prisma.project.findFirst({ where: { slug: appName, companyId }, select: { id: true } });
  return !!project && (await can(userId, companyId, permission, project.id, { membershipChecked: true }));
}
