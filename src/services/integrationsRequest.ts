/**
 * Someone wants Integrations in a workspace where it is off: an AI agent
 * turning it on for an app, or a member pressing Request in the dashboard.
 * Neither can flip the workspace switch, so the Owners are emailed: who
 * asked, for which app (when there is one), and where to turn it on. At
 * most one email per app (or per workspace, for a request with no app) per
 * day, so retries do not flood anyone.
 */
import { prisma } from "../lib/prisma";
import { getCompanyById, getUserById } from "../lib/msg91";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";
import { callWebhook, Webhook } from "../lib/webhooks";
import { renderNoticeEmail } from "./scheduleAlerts";
import { logAudit } from "./audit";
import { logger } from "../lib/logger";

const ACTION = "integrations.request";
const THROTTLE_MS = 24 * 60 * 60 * 1000;

// Returns how many owners were emailed (0 when throttled or none has an email).
export async function requestWorkspaceIntegrations(
  companyId: string,
  project: { id: string; slug: string; name?: string | null } | null,
  actorUserId: string,
  // Who asked, in words: an email when known, else "An AI agent".
  requestedBy: string
): Promise<number> {
  const recent = await prisma.auditLog.findFirst({
    where: { companyId, projectId: project?.id ?? null, action: ACTION, createdAt: { gte: new Date(Date.now() - THROTTLE_MS) } },
    select: { id: true },
  });
  if (recent) return 0;

  const owners = await prisma.workspaceMember.findMany({ where: { companyId, role: "owner" }, select: { userId: true } });
  const emails = (await Promise.all(owners.map((o) => getUserById(o.userId).catch(() => null))))
    .map((u) => u?.email)
    .filter((e): e is string => !!e);
  if (emails.length === 0) {
    logger.warn(`[integrations] no owner email to notify for ${companyId}`);
    return 0;
  }

  const companyName = (await getCompanyById(companyId).catch(() => null))?.name ?? "your workspace";
  const where = `workspace ${companyName} (ID ${companyId})`;
  const app = project ? project.name || project.slug : null;
  const html = renderNoticeEmail({
    title: app ? `Integrations requested for ${app}` : `Integrations requested in ${companyName}`,
    body: app
      ? `${requestedBy} requested Integrations for the app ${app} (${project!.slug}) in ${where}. Integrations is currently off for this workspace. You can turn it on under Settings.`
      : `${requestedBy} requested Integrations in ${where}. Integrations is currently off for this workspace. You can turn it on under Settings.`,
    cta: { url: `${FRONTEND_ORIGIN}/app/settings`, label: "Open workspace settings" },
    footer: "You get this because you are an Owner of the workspace.",
  });
  try {
    await callWebhook(Webhook.INTEGRATIONS_REQUEST_EMAIL, {
      to: emails.map((email) => ({ email })),
      subject: app ? `Integrations requested for ${app} in ${companyName}` : `Integrations requested in ${companyName}`,
      variables: { content: html },
    });
  } catch (err) {
    logger.error(`[integrations] owner email failed for ${project?.id ?? companyId}: ${(err as Error).message}`);
    return 0;
  }
  await logAudit({ actorUserId, companyId, projectId: project?.id, action: ACTION, details: `${emails.length} owner(s)` });
  return emails.length;
}
