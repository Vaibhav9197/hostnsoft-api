/**
 * Roles and app access for a workspace's members, plus the caller's own
 * permissions so the dashboard can hide what they can't do. The rules live
 * in services/workspaceRoles.ts and lib/permissions.ts; this file is
 * addressing, validation and reply shapes.
 *
 * Membership itself lives on proxy; inviting and removing people here
 * changes it there too — see the header of workspaceRoles.ts.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { accessFor, requirePermission } from "../middleware/requirePermission";
import { ACCESS_LEVELS, APP_ACCESS, ROLES, allowedPermissions, projectLevel, resolveAccess } from "../lib/permissions";
import { isCompanyMember } from "../lib/msg91";
import {
  appAccessList,
  changeMember,
  createInvite,
  deleteInvite,
  getMember,
  listMembers,
  recentJoins,
  removeMember,
  resendInvite,
  setAppAccess,
  setAppGrants,
  transferOwnership,
  type RoleError,
} from "../services/workspaceRoles";
import {
  LINK_ACCESS,
  LINK_ROLES,
  LINK_RULES,
  approveRequest,
  disableLink,
  ensureLink,
  getLink,
  joinWithLink,
  listRequests,
  myRequestForLink,
  rejectRequest,
  resetLink,
  updateLink,
} from "../services/inviteLinks";

export const membersRouter = Router();
membersRouter.use(requireProxyToken);

function sendRoleError(res: Response, err: RoleError) {
  return res.status(err.status).json({ error: err.error, code: err.code });
}

// Who is in the workspace and what each person may do. Readable by every
// member, like the embed's own list: knowing who to ask is part of being
// told "you don't have permission".
membersRouter.get("/companies/:companyId/members", loadCompanyContext, async (req, res) => {
  await accessFor(req);
  res.json(await listMembers(req.company!.id, req.userId!));
});

membersRouter.get("/companies/:companyId/members/:userId", loadCompanyContext, async (req, res) => {
  await accessFor(req);
  const member = await getMember(req.company!.id, req.params.userId, req.userId!);
  if (!member) return res.status(404).json({ error: "That person isn't a member of this workspace.", code: "member_not_found" });
  res.json(member);
});

const roleChangeSchema = z.object({
  role: z.enum(ROLES),
  access: z.enum(APP_ACCESS).optional(),
});

membersRouter.patch(
  "/companies/:companyId/members/:userId",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const change = roleChangeSchema.parse(req.body);
    const result = await changeMember(req.access!, req.params.userId, change);
    if (!result.ok) return sendRoleError(res, result.err);
    res.json(result.member);
  }
);

const grantsSchema = z.object({
  grants: z.array(z.object({ projectId: z.string().min(1), level: z.enum(ACCESS_LEVELS) })).max(500),
});

membersRouter.put(
  "/companies/:companyId/members/:userId/apps",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const { grants } = grantsSchema.parse(req.body);
    const result = await setAppGrants(req.access!, req.params.userId, grants);
    if (!result.ok) return sendRoleError(res, result.err);
    res.json(result.member);
  }
);

// Removes someone from the workspace, on proxy and here.
membersRouter.delete(
  "/companies/:companyId/members/:userId",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const result = await removeMember(req.access!, req.params.userId, req.proxyAuthToken!);
    if (!result.ok) return sendRoleError(res, result.err);
    res.status(204).end();
  }
);

const inviteSchema = roleChangeSchema.extend({
  email: z.string().trim().email(),
  grants: grantsSchema.shape.grants.optional(),
});

// Invites someone: records the role and access they get, has proxy add them
// to the workspace as the caller, then sends Embarko's invite email
// (services/workspaceRoles.ts createInvite).
membersRouter.post(
  "/companies/:companyId/invites",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const input = inviteSchema.parse(req.body);
    const result = await createInvite(req.access!, input, req.proxyAuthToken!);
    if (!result.ok) return sendRoleError(res, result.err);
    res.status(201).json(result.invite);
  }
);

membersRouter.delete(
  "/companies/:companyId/invites/:inviteId",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const result = await deleteInvite(req.access!, req.params.inviteId, req.proxyAuthToken!);
    if (!result.ok) {
      return result.status === 404
        ? res.status(404).json({ error: "Invite not found" })
        : res.status(403).json({ error: result.error, code: result.code });
    }
    res.status(204).end();
  }
);

membersRouter.post(
  "/companies/:companyId/invites/:inviteId/resend",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const result = await resendInvite(req.access!, req.params.inviteId);
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json(result.invite);
  }
);

// Owner only (checked in the service, so the reply can say why).
membersRouter.post(
  "/companies/:companyId/transfer-ownership",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    const result = await transferOwnership(req.access!, userId);
    if (!result.ok) return sendRoleError(res, result.err);
    res.json(result.member);
  }
);

// People who joined lately, for the "X joined your workspace" note.
membersRouter.get("/companies/:companyId/activity/joins", loadCompanyContext, async (req, res) => {
  await accessFor(req);
  res.json({ joins: await recentJoins(req.company!.id) });
});

// ---------------------------------------------------------------- one app's people

// Who can reach this app and how far — the app's Share panel. Anyone who
// can see the app can see who else can.
membersRouter.get(
  "/companies/:companyId/projects/:projectId/access",
  loadCompanyContext,
  loadProjectContext,
  requirePermission("app.view"),
  async (req, res) => {
    const list = await appAccessList(req.company!.id, req.params.projectId, req.userId!);
    if (!list) return res.status(404).json({ error: "App not found" });
    res.json(list);
  }
);

membersRouter.put(
  "/companies/:companyId/projects/:projectId/access/:userId",
  loadCompanyContext,
  loadProjectContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const { level } = z.object({ level: z.enum(ACCESS_LEVELS).nullable() }).parse(req.body);
    const result = await setAppAccess(req.access!, req.params.projectId, req.params.userId, level);
    if (!result.ok) return res.status(result.err.status).json({ error: result.err.error, code: result.err.code });
    res.status(204).end();
  }
);

// ---------------------------------------------------------------- invite link

const linkSettingsSchema = z.object({
  rule: z.enum(LINK_RULES).optional(),
  domains: z.array(z.string().max(253)).max(20).optional(),
  role: z.enum(LINK_ROLES).optional(),
  access: z.enum(LINK_ACCESS).optional(),
});

// The live link or null. GET never makes one; POST does.
membersRouter.get("/companies/:companyId/invite-link", loadCompanyContext, requirePermission("members.manage"), async (req, res) => {
  res.json({ link: await getLink(req.company!.id) });
});

membersRouter.post("/companies/:companyId/invite-link", loadCompanyContext, requirePermission("members.manage"), async (req, res) => {
  res.json({ link: await ensureLink(req.access!) });
});

membersRouter.patch("/companies/:companyId/invite-link", loadCompanyContext, requirePermission("members.manage"), async (req, res) => {
  const result = await updateLink(req.access!, linkSettingsSchema.parse(req.body));
  if (!result.ok) return res.status(result.err.status).json({ error: result.err.error, code: result.err.code });
  res.json({ link: result.link });
});

membersRouter.post("/companies/:companyId/invite-link/reset", loadCompanyContext, requirePermission("members.manage"), async (req, res) => {
  res.json({ link: await resetLink(req.access!) });
});

membersRouter.post("/companies/:companyId/invite-link/disable", loadCompanyContext, requirePermission("members.manage"), async (req, res) => {
  await disableLink(req.access!);
  res.json({ link: null });
});

// ---------------------------------------------------------------- join requests

membersRouter.get("/companies/:companyId/join-requests", loadCompanyContext, requirePermission("members.manage"), async (req, res) => {
  res.json({ requests: await listRequests(req.company!.id) });
});

membersRouter.post(
  "/companies/:companyId/join-requests/:requestId/approve",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const choice = z.object({ role: z.enum(ROLES).optional(), access: z.enum(APP_ACCESS).optional() }).parse(req.body ?? {});
    const result = await approveRequest(req.access!, req.params.requestId, choice, req.proxyAuthToken!);
    if (!result.ok) return res.status(result.err.status).json({ error: result.err.error, code: result.err.code });
    res.status(204).end();
  }
);

membersRouter.post(
  "/companies/:companyId/join-requests/:requestId/reject",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const result = await rejectRequest(req.access!, req.params.requestId);
    if (!result.ok) return res.status(result.err.status).json({ error: result.err.error, code: result.err.code });
    res.status(204).end();
  }
);

// ---------------------------------------------------------------- joining (signed in)

const joinSchema = z.object({ reason: z.string().max(300).optional() });

function sendJoin(res: Response, result: Awaited<ReturnType<typeof joinWithLink>>) {
  switch (result.status) {
    case "invalid":
      return res.status(404).json({ error: "This invite link doesn't work.", code: "invalid_link" });
    case "no_email":
      return res.status(400).json({ error: "Your account has no email address, so it can't be checked against this link.", code: "no_email" });
    case "not_eligible":
      return res.status(403).json({ error: "You need access to join this workspace.", code: "not_eligible" });
    default:
      return res.json(result);
  }
}

function joiner(req: Request) {
  const identity = req.proxyIdentity;
  return { userId: req.userId!, email: identity?.email ?? null, name: identity?.name ?? null };
}

// The caller's own request, if any — so the join page survives a reload.
membersRouter.get("/invite-links/:code/me", async (req, res) => {
  res.json({ request: await myRequestForLink(req.params.code, req.userId!) });
});

// "Join workspace": the link's rule decides, on proxy's verified email.
membersRouter.post("/invite-links/:code/join", async (req, res) => {
  sendJoin(res, await joinWithLink(req.params.code, joiner(req)));
});

// "Request access", for someone the rule doesn't let in.
membersRouter.post("/invite-links/:code/request", async (req, res) => {
  const { reason } = joinSchema.parse(req.body ?? {});
  sendJoin(res, await joinWithLink(req.params.code, joiner(req), { askAnyway: true, reason }));
});

// What the caller may do in one workspace, so the dashboard can hide or
// disable what they can't — the API still enforces every one of these.
// `apps` lists every app they can see, with their access level and what it
// lets them do. `defaultAccess` is a Member's level on apps nobody gave
// them more access to (null for other roles).
membersRouter.get("/me/permissions", async (req, res) => {
  const { companyId } = z.object({ companyId: z.string().min(1) }).parse(req.query);
  if (!(await isCompanyMember(req.userId!, companyId))) {
    return res.status(404).json({ error: "Workspace not found" });
  }
  const access = await resolveAccess(req.userId!, companyId, {
    membershipChecked: true,
    email: req.proxyIdentity?.email ?? null,
  });
  if (!access) return res.status(404).json({ error: "Workspace not found" });

  const projects = await prisma.project.findMany({ where: { companyId }, select: { id: true, createdBy: true } });
  res.json({
    companyId,
    userId: access.userId,
    role: access.role,
    roleIsSet: access.explicit,
    access: access.appAccess,
    permissions: allowedPermissions(access),
    apps: projects.flatMap((p) => {
      const level = projectLevel(access, p);
      return level ? [{ projectId: p.id, level, permissions: allowedPermissions(access, p) }] : [];
    }),
  });
});
