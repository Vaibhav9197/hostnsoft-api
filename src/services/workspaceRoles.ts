/**
 * Changing who may do what in a workspace: the members list with roles,
 * role changes, per-app access, and invites with a role chosen up front.
 * Reading permissions is lib/permissions.ts; this is the writing side and
 * its guard rails. Routes in routes/members.routes.ts.
 *
 * Membership itself — adding and removing people, the invite email — stays
 * proxy's, through the members embed on the dashboard. That's why nothing
 * here deletes a member: removing them on proxy is what takes access away
 * (permissions.ts checks proxy first), and a row left behind is inert.
 *
 * Guard rails, all enforced here rather than in the UI:
 *   - only an Owner may make, change or un-make an Owner or Admin;
 *   - a workspace always keeps at least one Owner who is still a member;
 *   - if every Owner has left proxy (nobody here could stop that), an
 *     Admin may make someone Owner — otherwise the workspace would have
 *     nobody able to manage billing or Admins, forever.
 */
import { prisma } from "../lib/prisma";
import { getUserByEmail, getUserById, isCompanyMember, listCompanyMembers } from "../lib/msg91";
import {
  DEFAULT_ROLE,
  startSetUp,
  parseInviteGrants,
  resolveAccess,
  ensureMemberRow,
  type Access,
  MEMBER_DEFAULT_LEVEL,
  type AccessLevel,
  type InviteGrant,
  type Role,
} from "../lib/permissions";
import { logAudit } from "./audit";

export type RoleChange = {
  role: Role;
};

// One member as every endpoint returns them — list, get-one, and the reply
// to a change — so a client never has to merge shapes.
export interface MemberView {
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
  // false: no role was ever set, DEFAULT_ROLE applies.
  roleIsSet: boolean;
  // A Member's access to apps not listed in `apps` (null for other roles:
  // Owner and Admin have full access to every app, Billing to none).
  defaultAccess: AccessLevel | null;
  // A Member's access to particular apps, above defaultAccess.
  apps: { projectId: string; level: AccessLevel }[];
  isYou: boolean;
}

export type RoleError =
  | { status: 403; code: "owner_required"; error: string }
  | { status: 404; code: "member_not_found"; error: string }
  | { status: 409; code: "last_owner" | "already_member"; error: string }
  | { status: 400; code: "unknown_app"; error: string };

const OWNERISH: ReadonlySet<Role> = new Set<Role>(["owner", "admin"]);

// Owners who are still in the workspace on proxy. A handful at most, so one
// membership call each is fine on what is always a deliberate, rare action.
async function liveOwnerIds(companyId: string): Promise<string[]> {
  const owners = await prisma.workspaceMember.findMany({ where: { companyId, role: "owner" }, select: { userId: true } });
  const flags = await Promise.all(owners.map((o) => isCompanyMember(o.userId, companyId)));
  return owners.filter((_, i) => flags[i]).map((o) => o.userId);
}

// May `actor` touch someone whose role is (or would become) owner/admin?
async function mayManageOwnerish(actor: Access): Promise<boolean> {
  if (actor.role === "owner") return true;
  // The recovery case: no Owner left who is still a member.
  return actor.role === "admin" && (await liveOwnerIds(actor.companyId)).length === 0;
}

function describe(r: { role: string }): string {
  return r.role;
}

async function grantsByUser(companyId: string): Promise<Map<string, { projectId: string; level: AccessLevel }[]>> {
  const rows = await prisma.appGrant.findMany({
    where: { project: { companyId } },
    select: { userId: true, projectId: true, level: true },
    orderBy: { createdAt: "asc" },
  });
  const out = new Map<string, { projectId: string; level: AccessLevel }[]>();
  for (const g of rows) {
    const list = out.get(g.userId) ?? [];
    list.push({ projectId: g.projectId, level: g.level as AccessLevel });
    out.set(g.userId, list);
  }
  return out;
}

type Row = Awaited<ReturnType<typeof prisma.workspaceMember.findMany>>[number];

function toView(
  userId: string,
  person: { name?: string | null; email?: string | null } | null,
  row: Row | undefined,
  apps: { projectId: string; level: AccessLevel }[],
  callerId: string
): MemberView {
  return {
    userId,
    name: person?.name || null,
    email: person?.email || null,
    role: (row?.role as Role | undefined) ?? DEFAULT_ROLE,
    roleIsSet: !!row,
    defaultAccess: row?.role === "member" ? MEMBER_DEFAULT_LEVEL : null,
    // Grants only count for a Member; anyone else's are left over from an
    // earlier role and do nothing.
    apps: row?.role === "member" ? apps : [],
    isYou: userId === callerId,
  };
}

export async function listMembers(companyId: string, callerId: string) {
  // Its first look at this workspace may be the members page: finish the
  // roles setup first, so the roles shown are the ones people will have.
  await startSetUp(companyId);
  const [proxyMembers, rows, grants, invites] = await Promise.all([
    listCompanyMembers(companyId),
    prisma.workspaceMember.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
    grantsByUser(companyId),
    prisma.pendingInvite.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
  ]);
  const rowByUser = new Map(rows.map((r) => [r.userId, r]));
  // Confirmed members nobody has given a role yet get their default now, so
  // the page shows the role they will actually have (permissions.ts).
  for (const u of proxyMembers ?? []) {
    if (rowByUser.has(u.id)) continue;
    const row = await ensureMemberRow(u.id, companyId, u.email);
    if (row) rowByUser.set(u.id, row);
  }

  let members: MemberView[];
  if (proxyMembers) {
    members = proxyMembers.map((u) => toView(u.id, u, rowByUser.get(u.id), grants.get(u.id) ?? [], callerId));
  } else {
    // Proxy couldn't give a trustworthy list: show the people we have a
    // role for, plus the caller, each re-checked so nobody who has left is
    // listed. `complete: false` tells the page to say the list may be
    // partial and point at the embed below it for the rest.
    const ids = [...new Set([callerId, ...rows.map((r) => r.userId)])];
    const flags = await Promise.all(ids.map((id) => (id === callerId ? true : isCompanyMember(id, companyId))));
    const live = ids.filter((_, i) => flags[i]);
    const people = await Promise.all(live.map((id) => getUserById(id).catch(() => null)));
    members = live.map((id, i) => toView(id, people[i], rowByUser.get(id), grants.get(id) ?? [], callerId));
  }

  return {
    members,
    complete: proxyMembers !== null,
    invites: invites.map(toInviteView),
  };
}

export async function getMember(companyId: string, userId: string, callerId: string): Promise<MemberView | null> {
  if (!(await isCompanyMember(userId, companyId))) return null;
  const [row, person, grants] = await Promise.all([
    ensureMemberRow(userId, companyId),
    getUserById(userId).catch(() => null),
    grantsByUser(companyId),
  ]);
  return toView(userId, person, row ?? undefined, grants.get(userId) ?? [], callerId);
}

export async function changeMember(
  actor: Access,
  targetUserId: string,
  change: RoleChange
): Promise<{ ok: true; member: MemberView } | { ok: false; err: RoleError }> {
  const companyId = actor.companyId;
  if (!(await isCompanyMember(targetUserId, companyId))) {
    return { ok: false, err: { status: 404, code: "member_not_found", error: "That person isn't a member of this workspace." } };
  }
  await startSetUp(companyId);

  // Their access as it is now, through the same resolver a request uses —
  // so an invite waiting for them is applied first rather than clobbered.
  const current = await resolveAccess(targetUserId, companyId, { membershipChecked: true });
  const currentRole = current?.role ?? DEFAULT_ROLE;

  if ((OWNERISH.has(currentRole) || OWNERISH.has(change.role)) && !(await mayManageOwnerish(actor))) {
    return {
      ok: false,
      err: { status: 403, code: "owner_required", error: "Only an Owner can change who is an Owner or Admin." },
    };
  }

  if (currentRole === "owner" && change.role !== "owner") {
    const others = (await liveOwnerIds(companyId)).filter((id) => id !== targetUserId);
    if (others.length === 0) {
      return {
        ok: false,
        err: {
          status: 409,
          code: "last_owner",
          error: "A workspace needs at least one Owner. Make someone else an Owner first.",
        },
      };
    }
  }

  const before = await prisma.workspaceMember.findUnique({ where: { companyId_userId: { companyId, userId: targetUserId } } });
  const data = { role: change.role };
  // Per-app access only means something for a Member; leaving that role
  // clears it, so it can't quietly come back if they're made a Member again.
  await prisma.$transaction([
    prisma.workspaceMember.upsert({
      where: { companyId_userId: { companyId, userId: targetUserId } },
      update: data,
      create: { companyId, userId: targetUserId, ...data },
    }),
    ...(change.role === "member"
      ? []
      : [prisma.appGrant.deleteMany({ where: { userId: targetUserId, project: { companyId } } })]),
  ]);

  await logAudit({
    actorUserId: actor.userId,
    companyId,
    action: "member.role_change",
    details: `${targetUserId}: ${before ? describe(before) : `(default ${DEFAULT_ROLE})`} -> ${describe(data)}`,
  });

  return { ok: true, member: (await getMember(companyId, targetUserId, actor.userId))! };
}

// Replaces the whole list — what the per-app editor sends. Projects must be
// this workspace's; an unknown one fails the whole call rather than being
// silently dropped, so the editor never shows a saved state that isn't.
export async function setAppGrants(
  actor: Access,
  targetUserId: string,
  grants: InviteGrant[]
): Promise<{ ok: true; member: MemberView } | { ok: false; err: RoleError }> {
  const companyId = actor.companyId;
  if (!(await isCompanyMember(targetUserId, companyId))) {
    return { ok: false, err: { status: 404, code: "member_not_found", error: "That person isn't a member of this workspace." } };
  }
  const current = await resolveAccess(targetUserId, companyId, { membershipChecked: true });
  if (OWNERISH.has(current?.role ?? DEFAULT_ROLE) && !(await mayManageOwnerish(actor))) {
    return { ok: false, err: { status: 403, code: "owner_required", error: "Only an Owner can change an Owner's or Admin's access." } };
  }

  const unique = [...new Map(grants.map((g) => [g.projectId, g])).values()];
  const found = await prisma.project.findMany({
    where: { companyId, id: { in: unique.map((g) => g.projectId) } },
    select: { id: true, slug: true },
  });
  if (found.length !== unique.length) {
    return { ok: false, err: { status: 400, code: "unknown_app", error: "One of those apps isn't in this workspace." } };
  }
  const slugById = new Map(found.map((p) => [p.id, p.slug]));

  await prisma.$transaction([
    prisma.appGrant.deleteMany({ where: { userId: targetUserId, project: { companyId } } }),
    ...unique.map((g) => prisma.appGrant.create({ data: { projectId: g.projectId, userId: targetUserId, level: g.level } })),
  ]);

  await logAudit({
    actorUserId: actor.userId,
    companyId,
    action: "member.app_access",
    details: `${targetUserId}: ${unique.map((g) => `${slugById.get(g.projectId)}=${g.level}`).join(", ") || "(none)"}`,
  });

  return { ok: true, member: (await getMember(companyId, targetUserId, actor.userId))! };
}

export interface InviteInput extends RoleChange {
  email: string;
  grants?: InviteGrant[];
}

function toInviteView(i: Awaited<ReturnType<typeof prisma.pendingInvite.findMany>>[number]) {
  return {
    id: i.id,
    email: i.email,
    role: i.role as Role,
    apps: parseInviteGrants(i.grants),
    invitedBy: i.invitedBy,
    createdAt: i.createdAt,
  };
}

export async function createInvite(actor: Access, input: InviteInput) {
  const companyId = actor.companyId;
  const email = input.email.trim().toLowerCase();

  if (OWNERISH.has(input.role) && !(await mayManageOwnerish(actor))) {
    return { ok: false as const, err: { status: 403, code: "owner_required", error: "Only an Owner can invite an Owner or Admin." } as RoleError };
  }

  const grants = input.grants ?? [];
  if (grants.length) {
    const found = await prisma.project.count({ where: { companyId, id: { in: grants.map((g) => g.projectId) } } });
    if (found !== new Set(grants.map((g) => g.projectId)).size) {
      return { ok: false as const, err: { status: 400, code: "unknown_app", error: "One of those apps isn't in this workspace." } as RoleError };
    }
  }

  // An invite only applies to someone with no role here yet. Someone who is
  // already in must have their role changed instead; someone who left and
  // is being invited back must not get their old role back, so the stale
  // row goes. Lookup by email is admin-key and may find nobody (a brand-new
  // person) — then there's nothing to clean up.
  const existing = await getUserByEmail(email).catch(() => null);
  if (existing) {
    if (await isCompanyMember(existing.id, companyId)) {
      return {
        ok: false as const,
        err: { status: 409, code: "already_member", error: "They're already in this workspace — change their role instead." } as RoleError,
      };
    }
    await prisma.$transaction([
      prisma.workspaceMember.deleteMany({ where: { companyId, userId: existing.id } }),
      prisma.appGrant.deleteMany({ where: { userId: existing.id, project: { companyId } } }),
    ]);
  }

  const data = {
    role: input.role,
    grants: JSON.stringify(input.role === "member" ? grants : []),
    invitedBy: actor.userId,
  };
  const invite = await prisma.pendingInvite.upsert({
    where: { companyId_email: { companyId, email } },
    update: data,
    create: { companyId, email, ...data },
  });

  await logAudit({
    actorUserId: actor.userId,
    companyId,
    action: "member.invite",
    details: `${email} as ${describe(data)}`,
  });
  return { ok: true as const, invite: toInviteView(invite) };
}

export async function deleteInvite(actor: Access, inviteId: string) {
  const invite = await prisma.pendingInvite.findFirst({ where: { id: inviteId, companyId: actor.companyId } });
  if (!invite) return { ok: false as const, status: 404 as const };
  if (OWNERISH.has(invite.role as Role) && !(await mayManageOwnerish(actor))) {
    return {
      ok: false as const,
      status: 403 as const,
      code: "owner_required",
      error: "Only an Owner can cancel an Owner or Admin invite.",
    };
  }
  await prisma.pendingInvite.delete({ where: { id: invite.id } });
  await logAudit({
    actorUserId: actor.userId,
    companyId: actor.companyId,
    action: "member.invite_cancel",
    details: `${invite.email} (${invite.role})`,
  });
  return { ok: true as const };
}
