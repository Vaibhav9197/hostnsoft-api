/**
 * Roles and app access for a workspace's members, plus the caller's own
 * permissions so the dashboard can hide what they can't do. The rules live
 * in services/workspaceRoles.ts and lib/permissions.ts; this file is
 * addressing, validation and reply shapes.
 *
 * Membership itself (adding, removing, the invite email) is still proxy's,
 * through the members embed — see the header of workspaceRoles.ts.
 */
import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { accessFor, requirePermission } from "../middleware/requirePermission";
import {
  APP_LEVELS,
  APP_SCOPES,
  ROLES,
  allowedPermissions,
  appLevel,
  resolveAccess,
} from "../lib/permissions";
import { isCompanyMember } from "../lib/msg91";
import {
  changeMember,
  createInvite,
  deleteInvite,
  getMember,
  listMembers,
  setAppGrants,
  type RoleError,
} from "../services/workspaceRoles";

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
  appScope: z.enum(APP_SCOPES).optional(),
  canCreate: z.boolean().optional(),
  canDelete: z.boolean().optional(),
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
  grants: z.array(z.object({ projectId: z.string().min(1), level: z.enum(APP_LEVELS) })).max(500),
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

const inviteSchema = roleChangeSchema.extend({
  email: z.string().trim().email(),
  grants: grantsSchema.shape.grants.optional(),
});

// Records the role someone gets when they join. It does NOT send the invite
// email: that's proxy's, and the dashboard sends it through the members
// embed right after this succeeds (the API can't — proxy's invite call is
// user-key on the inviter's current company and its shape is unverified on
// this account; see docs/CLAUDE.md open question 6).
membersRouter.post(
  "/companies/:companyId/invites",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const input = inviteSchema.parse(req.body);
    const result = await createInvite(req.access!, input);
    if (!result.ok) return sendRoleError(res, result.err);
    res.status(201).json(result.invite);
  }
);

membersRouter.delete(
  "/companies/:companyId/invites/:inviteId",
  loadCompanyContext,
  requirePermission("members.manage"),
  async (req, res) => {
    const result = await deleteInvite(req.access!, req.params.inviteId);
    if (!result.ok) {
      return result.status === 404
        ? res.status(404).json({ error: "Invite not found" })
        : res.status(403).json({ error: "Only an Owner can cancel an Owner or Admin invite.", code: "owner_required" });
    }
    res.status(204).end();
  }
);

// What the caller may do in one workspace, so the dashboard can hide or
// disable what they can't — the API still enforces every one of these.
// `apps` lists every app they can see, with what they can do to each.
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
    appScope: access.appScope,
    canCreate: access.canCreate,
    canDelete: access.canDelete,
    permissions: allowedPermissions(access),
    apps: projects.flatMap((p) => {
      const level = appLevel(access, p);
      return level ? [{ projectId: p.id, level, permissions: allowedPermissions(access, p) }] : [];
    }),
  });
});
