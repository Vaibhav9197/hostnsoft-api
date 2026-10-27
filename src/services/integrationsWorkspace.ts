/**
 * Provisioning the hidden viasocket workspace behind one Embarko
 * workspace — see docs/integrations.md.
 *
 * Lazy by design: a workspace that never uses Integrations never gets one.
 * The first app that turns Integrations on creates it.
 *
 * The owner is a real person's email: the member who turned it on from
 * the dashboard, or on the agent path the workspace's Owner (falling back to whoever
 * created the deploy token). viasocket needs a real account behind SSO,
 * and logging in again as that person is how later calls get a session.
 *
 * Membership is NOT checked here. Callers do that — every route above this
 * one asks proxy live (loadCompanyContext) before reaching this service.
 */
import { prisma } from "../lib/prisma";
import type { IntegrationsWorkspace } from "@prisma/client";
import { isUniqueConstraintViolation } from "../lib/prismaErrors";
import { consoleUrl, orgAuthKey, signSsoToken, ssoLogin, workspaceTitleFor } from "../lib/viasocket";
import { getUserById } from "../lib/msg91";
import { logAudit } from "./audit";
import { logger } from "../lib/logger";

// First provisioning per workspace is serialised in-process: viasocket
// creates a workspace for any TITLE it has not seen, and its docs promise
// idempotence only for a workspace and user that already exist — not for
// two simultaneous creates of the same new title. In-process only, like
// services/renameStatus.ts; the primary key below is the backstop.
const provisioning = new Map<string, Promise<IntegrationsWorkspace>>();

// `email` is the acting member's address on the dashboard path. Null on
// the agent path: the workspace Owner's email is used instead.
export async function ensureIntegrationsWorkspace(
  companyId: string,
  actorUserId: string,
  email: string | null = null
): Promise<IntegrationsWorkspace> {
  const existing = await prisma.integrationsWorkspace.findUnique({ where: { companyId } });
  if (existing) return existing;

  const inFlight = provisioning.get(companyId);
  if (inFlight) return inFlight;

  const pending = provision(companyId, actorUserId, email).finally(() => provisioning.delete(companyId));
  provisioning.set(companyId, pending);
  return pending;
}

// The workspace Owner's email, else the actor's own. Throws when neither
// has one: viasocket keys users by email, so there is nothing to sign.
async function ownerEmailFor(companyId: string, actorUserId: string): Promise<string> {
  const owner = await prisma.workspaceMember.findFirst({ where: { companyId, role: "owner" }, orderBy: { createdAt: "asc" } });
  for (const id of [owner?.userId, actorUserId]) {
    if (!id || id.startsWith("agent:") || id.startsWith("system:") || id === "hostnsoft-deploy") continue;
    const email = (await getUserById(id))?.email;
    if (email) return email;
  }
  throw Object.assign(new Error("No owner email found for this workspace"), {
    status: 409,
    publicMessage: "Add an email address to the workspace owner's account before turning Integrations on.",
    code: "email_required",
  });
}

// A fresh viasocket session for this workspace, as its owner. SSO login is
// idempotent for an existing workspace and user, so this is just a login.
export async function sessionFor(workspace: IntegrationsWorkspace): Promise<string> {
  const result = await ssoLogin(signSsoToken({ email: workspace.ownerEmail, title: workspaceTitleFor(workspace.companyId) }));
  return result.sessionToken;
}

async function provision(companyId: string, actorUserId: string, email: string | null): Promise<IntegrationsWorkspace> {
  const ownerEmail = email ?? (await ownerEmailFor(companyId, actorUserId));
  const title = workspaceTitleFor(companyId);

  // One call creates the workspace, creates the user in it, and logs that
  // user in; the session then fetches the workspace's own auth key.
  const result = await ssoLogin(signSsoToken({ email: ownerEmail, title }));
  const authKey = await orgAuthKey(result.workspaceId, result.sessionToken);

  try {
    const created = await prisma.integrationsWorkspace.create({
      data: {
        companyId,
        orgId: result.workspaceId,
        orgName: result.workspaceName,
        ownerEmail,
        ownerUserId: result.userId,
        authKey,
        createdBy: actorUserId,
      },
    });
    await logAudit({ actorUserId, companyId, action: "integrations.workspace.create", details: created.orgId });
    return created;
  } catch (err) {
    // Another process won. Its row is the one every later login must
    // agree with, so return that rather than the id we just received.
    if (isUniqueConstraintViolation(err)) {
      const raced = await prisma.integrationsWorkspace.findUnique({ where: { companyId } });
      if (raced) {
        logger.warn(`[integrations] workspace for ${companyId} was created concurrently; keeping the stored one`);
        return raced;
      }
    }
    throw err;
  }
}

// A link into viasocket for one member, signed in as themselves. The SSO
// login creates their viasocket user in the workspace on first use, so
// nobody signs up for anything. Provisions the workspace if needed.
export async function consoleLinkFor(
  companyId: string,
  actorUserId: string,
  email: string,
  embedProjectId?: string
): Promise<string> {
  const workspace = await ensureIntegrationsWorkspace(companyId, actorUserId, email);
  const { sessionToken } = await ssoLogin(signSsoToken({ email, title: workspaceTitleFor(companyId) }));
  return consoleUrl(workspace.orgId, sessionToken, embedProjectId);
}
