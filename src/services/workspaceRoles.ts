/**
 * Changing who may do what in a workspace: the members list with roles,
 * role changes, per-app access, and invites with a role chosen up front.
 * Reading permissions is lib/permissions.ts; this is the writing side and
 * its guard rails. Routes in routes/members.routes.ts.
 *
 * Membership itself lives on proxy: inviting and removing someone here calls
 * proxy as the person doing it (msg91.ts addUserToCompany /
 * removeUserFromCompany — the calls proxy's own members embed made); proxy
 * sends no email, so the invite email is ours (lib/memberInviteEmail.ts).
 * Removing someone on proxy is what takes
 * their access away (permissions.ts checks proxy first); their rows here
 * are deleted with it.
 *
 * Guard rails, all enforced here rather than in the UI:
 *   - only an Owner may make, change or un-make an Owner or Admin;
 *   - a workspace always keeps at least one Owner who is still a member;
 *   - if every Owner has left proxy (nobody here could stop that), an
 *     Admin may make someone Owner — otherwise the workspace would have
 *     nobody able to manage billing or Admins, forever.
 */
import { prisma } from "../lib/prisma";
import {
  addUserToCompany,
  getCompanyById,
  getUserByEmail,
  getUserById,
  isCompanyMember,
  listCompanyMembers,
  removeUserFromCompany,
} from "../lib/msg91";
import {
  DEFAULT_ROLE,
  startSetUp,
  parseInviteGrants,
  resolveAccess,
  ensureMemberRow,
  type Access,
  MEMBER_DEFAULT_ACCESS,
  type AccessLevel,
  type AppAccess,
  type InviteGrant,
  type Role,
} from "../lib/permissions";
import { logAudit } from "./audit";
import { callWebhook, Webhook } from "../lib/webhooks";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";
import { memberInviteEmailSubject, renderMemberInviteEmail } from "../lib/memberInviteEmail";
import { logger } from "../lib/logger";

export type RoleChange = {
  role: Role;
  // A Member's access (APP_ACCESS). Omitted: kept as it is (a new Member:
  // MEMBER_DEFAULT_ACCESS). Ignored for other roles.
  access?: AppAccess;
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
  // A Member's access: "use" | "edit" | "full" on every app, or "chosen"
  // (only `apps`). Null for other roles: Owner and Admin have full access
  // to every app, Billing to none. A Member always has full access to apps
  // they created (the app's createdBy), whatever this says.
  access: AppAccess | null;
  // With access "chosen": the apps they can reach and how far. Else [].
  apps: { projectId: string; level: AccessLevel }[];
  isYou: boolean;
  // When they last did anything in this workspace; null if not seen since
  // that started being recorded (WorkspaceMember.lastSeenAt).
  lastActiveAt: Date | null;
}

export type RoleError =
  | { status: 403; code: "owner_required"; error: string }
  | { status: 404; code: "member_not_found"; error: string }
  | { status: 409; code: "last_owner" | "already_member"; error: string }
  | { status: 400; code: "not_yourself"; error: string }
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
export async function mayManageOwnerish(actor: Access): Promise<boolean> {
  if (actor.role === "owner") return true;
  // The recovery case: no Owner left who is still a member.
  return actor.role === "admin" && (await liveOwnerIds(actor.companyId)).length === 0;
}

function describe(r: { role: string; appAccess?: string | null }): string {
  return r.role === "member" ? `member (apps: ${r.appAccess ?? MEMBER_DEFAULT_ACCESS})` : r.role;
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
    access: row?.role === "member" ? ((row.appAccess as AppAccess) ?? MEMBER_DEFAULT_ACCESS) : null,
    // Grants only count for a Member on chosen apps.
    apps: row?.role === "member" && row.appAccess === "chosen" ? apps : [],
    isYou: userId === callerId,
    lastActiveAt: row?.lastSeenAt ?? null,
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
  const appAccess: AppAccess =
    change.access ?? (before?.role === "member" ? (before.appAccess as AppAccess) : MEMBER_DEFAULT_ACCESS);
  const data = { role: change.role, appAccess };
  // Per-app grants only mean something for a Member on chosen apps; any
  // other role or access clears them, so they can't quietly come back.
  const keepGrants = change.role === "member" && appAccess === "chosen";
  await prisma.$transaction([
    prisma.workspaceMember.upsert({
      where: { companyId_userId: { companyId, userId: targetUserId } },
      update: data,
      create: { companyId, userId: targetUserId, ...data },
    }),
    ...(keepGrants ? [] : [prisma.appGrant.deleteMany({ where: { userId: targetUserId, project: { companyId } } })]),
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
  // With access "chosen": the apps they get, and how far.
  grants?: InviteGrant[];
}

function toInviteView(i: Awaited<ReturnType<typeof prisma.pendingInvite.findMany>>[number]) {
  return {
    id: i.id,
    email: i.email,
    role: i.role as Role,
    access: i.role === "member" ? (i.appAccess as AppAccess) : null,
    apps: parseInviteGrants(i.grants),
    invitedBy: i.invitedBy,
    createdAt: i.createdAt,
    lastSentAt: i.lastSentAt ?? i.createdAt,
  };
}

// The invite form asks only for an email, but proxy's addUser needs a name
// and refuses one with digits or symbols ("The user.name format is
// invalid"). So: the email's local part, plain letters only (accents
// dropped), words capitalised —
// "rahul.mehta" → "Rahul Mehta", "priyankapathak0811" → "Priyankapathak".
// They can change it on proxy once they've joined.
export function nameFromEmail(email: string): string {
  const words = email
    .split("@")[0]
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  return words.join(" ").slice(0, 60) || "Teammate";
}

// Records what they'll be allowed to do, has proxy add them to the
// workspace — as the caller, with their own session token — then emails
// them. If proxy refuses, the record goes too and its reason is passed on.
export async function createInvite(actor: Access, input: InviteInput, proxyAuthToken: string) {
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

  const appAccess: AppAccess = input.access ?? MEMBER_DEFAULT_ACCESS;
  const data = {
    role: input.role,
    appAccess,
    grants: JSON.stringify(input.role === "member" && appAccess === "chosen" ? grants : []),
    invitedBy: actor.userId,
  };
  const invite = await prisma.pendingInvite.upsert({
    where: { companyId_email: { companyId, email } },
    update: { ...data, lastSentAt: new Date() },
    create: { companyId, email, ...data, lastSentAt: new Date() },
  });

  try {
    await addUserToCompany(proxyAuthToken, companyId, { email, name: nameFromEmail(email) });
  } catch (err) {
    await prisma.pendingInvite.delete({ where: { id: invite.id } }).catch(() => undefined);
    throw err;
  }

  // They're in; the email only tells them. Best effort: a failed send is
  // logged, never turned into a failed invite.
  await sendInviteEmail(actor, companyId, email, input.role, appAccess, grants.length).catch((err) =>
    logger.warn(`[members] invite email to ${companyId} not sent: ${(err as Error)?.message}`)
  );

  await logAudit({
    actorUserId: actor.userId,
    companyId,
    action: "member.invite",
    details: `${email} as ${describe(data)}`,
  });
  return { ok: true as const, invite: toInviteView(invite) };
}

// Takes back an invite: the waiting role goes, and if proxy already added
// them to the workspace (its invite does), they're removed there too.
export async function deleteInvite(actor: Access, inviteId: string, proxyAuthToken: string) {
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
  const person = await getUserByEmail(invite.email).catch(() => null);
  if (person && (await isCompanyMember(person.id, actor.companyId))) {
    await removeUserFromCompany(proxyAuthToken, actor.companyId, person.id);
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

// Takes someone out of the workspace: on proxy (as the caller), then their
// role and app access here. Same guard rails as changing a role, and nobody
// removes themselves this way.
export async function removeMember(
  actor: Access,
  targetUserId: string,
  proxyAuthToken: string
): Promise<{ ok: true } | { ok: false; err: RoleError }> {
  const companyId = actor.companyId;
  if (targetUserId === actor.userId) {
    return { ok: false, err: { status: 400, code: "not_yourself", error: "You can't remove yourself here." } };
  }
  if (!(await isCompanyMember(targetUserId, companyId))) {
    return { ok: false, err: { status: 404, code: "member_not_found", error: "That person isn't a member of this workspace." } };
  }
  const current = await resolveAccess(targetUserId, companyId, { membershipChecked: true });
  const role = current?.role ?? DEFAULT_ROLE;
  if (OWNERISH.has(role) && !(await mayManageOwnerish(actor))) {
    return { ok: false, err: { status: 403, code: "owner_required", error: "Only an Owner can remove an Owner or Admin." } };
  }
  if (role === "owner" && (await liveOwnerIds(companyId)).filter((id) => id !== targetUserId).length === 0) {
    return {
      ok: false,
      err: { status: 409, code: "last_owner", error: "A workspace needs at least one Owner. Make someone else an Owner first." },
    };
  }

  await removeUserFromCompany(proxyAuthToken, companyId, targetUserId);
  await prisma.$transaction([
    prisma.workspaceMember.deleteMany({ where: { companyId, userId: targetUserId } }),
    prisma.appGrant.deleteMany({ where: { userId: targetUserId, project: { companyId } } }),
  ]);
  await logAudit({
    actorUserId: actor.userId,
    companyId,
    action: "member.remove",
    details: `${targetUserId} (${role})`,
  });
  return { ok: true };
}

const ROLE_NAMES_FOR_EMAIL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", billing: "Billing" };

function accessInWords(access: AppAccess, chosenCount: number): string {
  if (access === "use") return "Can use all apps";
  if (access === "edit") return "Can edit all apps";
  if (access === "full") return "Full access to all apps";
  return chosenCount === 1 ? "1 app" : `${chosenCount} apps`;
}

// Sends the invite email again. Once per RESEND_GAP_MS per invite, so the
// button can't be used to flood someone's inbox.
const RESEND_GAP_MS = 10 * 60 * 1000;

export async function resendInvite(actor: Access, inviteId: string) {
  const invite = await prisma.pendingInvite.findFirst({ where: { id: inviteId, companyId: actor.companyId } });
  if (!invite) return { ok: false as const, status: 404 as const, code: "invite_not_found", error: "Invite not found" };
  const last = (invite.lastSentAt ?? invite.createdAt).getTime();
  if (Date.now() - last < RESEND_GAP_MS) {
    return {
      ok: false as const,
      status: 429 as const,
      code: "resend_too_soon",
      error: "That invite was sent a few minutes ago. Try again in a little while.",
    };
  }
  const grants = parseInviteGrants(invite.grants);
  await sendInviteEmail(actor, actor.companyId, invite.email, invite.role as Role, invite.appAccess as AppAccess, grants.length);
  const updated = await prisma.pendingInvite.update({ where: { id: invite.id }, data: { lastSentAt: new Date() } });
  await logAudit({ actorUserId: actor.userId, companyId: actor.companyId, action: "member.invite_resend", details: invite.email });
  return { ok: true as const, invite: toInviteView(updated) };
}

// Hands the workspace to someone else in one step: they become Owner, the
// caller (an Owner) becomes Admin. The same thing as making them Owner and
// then stepping down, without the moment in between.
export async function transferOwnership(
  actor: Access,
  targetUserId: string
): Promise<{ ok: true; member: MemberView } | { ok: false; err: RoleError }> {
  const companyId = actor.companyId;
  if (actor.role !== "owner") {
    return { ok: false, err: { status: 403, code: "owner_required", error: "Only an Owner can hand over the workspace." } };
  }
  if (targetUserId === actor.userId) {
    return { ok: false, err: { status: 400, code: "not_yourself", error: "You're already the Owner." } };
  }
  if (!(await isCompanyMember(targetUserId, companyId))) {
    return { ok: false, err: { status: 404, code: "member_not_found", error: "That person isn't a member of this workspace." } };
  }
  await startSetUp(companyId);
  const before = await resolveAccess(targetUserId, companyId, { membershipChecked: true });
  await prisma.$transaction([
    prisma.workspaceMember.upsert({
      where: { companyId_userId: { companyId, userId: targetUserId } },
      update: { role: "owner", appAccess: MEMBER_DEFAULT_ACCESS },
      create: { companyId, userId: targetUserId, role: "owner", appAccess: MEMBER_DEFAULT_ACCESS },
    }),
    prisma.appGrant.deleteMany({ where: { userId: targetUserId, project: { companyId } } }),
    prisma.workspaceMember.upsert({
      where: { companyId_userId: { companyId, userId: actor.userId } },
      update: { role: "admin" },
      create: { companyId, userId: actor.userId, role: "admin" },
    }),
  ]);
  await logAudit({
    actorUserId: actor.userId,
    companyId,
    action: "member.transfer_ownership",
    details: `${actor.userId} -> ${targetUserId} (was ${before?.role ?? DEFAULT_ROLE}); ${actor.userId} is now admin`,
  });
  return { ok: true, member: (await getMember(companyId, targetUserId, actor.userId))! };
}

// ---------------------------------------------------------------- one app

export type AccessSource = "role" | "creator" | "workspace" | "app";

// Who can reach one app and how far, for the app's Share panel. Built from
// the same members list and the same projectLevel rule a request uses, so
// it can't disagree with what is enforced. `source` says where the level
// comes from: their role (Owner/Admin), having made the app, their
// workspace-wide access, or a level given for this app alone — only the
// last can be changed from the Share panel.
export async function appAccessList(companyId: string, projectId: string, callerId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, companyId }, select: { id: true, createdBy: true } });
  if (!project) return null;
  const { members, complete } = await listMembers(companyId, callerId);
  const people = members.flatMap((m) => {
    let level: AccessLevel | null = null;
    let source: AccessSource = "role";
    if (m.role === "owner" || m.role === "admin") level = "full";
    else if (m.role === "member") {
      if (project.createdBy && project.createdBy === m.userId) {
        level = "full";
        source = "creator";
      } else if (m.access === "chosen") {
        level = m.apps.find((a) => a.projectId === projectId)?.level ?? null;
        source = "app";
      } else {
        level = (m.access as AccessLevel | null) ?? null;
        source = "workspace";
      }
    }
    return level ? [{ userId: m.userId, name: m.name, email: m.email, role: m.role, level, source, isYou: m.isYou }] : [];
  });
  // Members on chosen apps without this one: who can be added here.
  const canAdd = members
    .filter((m) => m.role === "member" && m.access === "chosen" && !m.apps.some((a) => a.projectId === projectId))
    .map((m) => ({ userId: m.userId, name: m.name, email: m.email }));
  return { people, canAdd, complete };
}

// Gives or takes away one person's level on one app, leaving their other
// apps alone. Only for a Member on chosen apps: everyone else's access to
// this app comes from their role or workspace-wide access, changed on the
// People page.
export async function setAppAccess(
  actor: Access,
  projectId: string,
  targetUserId: string,
  level: AccessLevel | null
): Promise<{ ok: true } | { ok: false; err: RoleError | { status: 409; code: "not_chosen"; error: string } }> {
  const companyId = actor.companyId;
  if (!(await isCompanyMember(targetUserId, companyId))) {
    return { ok: false, err: { status: 404, code: "member_not_found", error: "That person isn't a member of this workspace." } };
  }
  const project = await prisma.project.findFirst({ where: { id: projectId, companyId }, select: { id: true, slug: true } });
  if (!project) return { ok: false, err: { status: 400, code: "unknown_app", error: "That app isn't in this workspace." } };
  const current = await resolveAccess(targetUserId, companyId, { membershipChecked: true });
  if (!current || current.role !== "member" || current.appAccess !== "chosen") {
    return {
      ok: false,
      err: {
        status: 409,
        code: "not_chosen",
        error: "Their access to this app comes from their workspace role. Change it on the People page.",
      },
    };
  }
  if (level) {
    await prisma.appGrant.upsert({
      where: { projectId_userId: { projectId, userId: targetUserId } },
      update: { level },
      create: { projectId, userId: targetUserId, level },
    });
  } else {
    await prisma.appGrant.deleteMany({ where: { projectId, userId: targetUserId } });
  }
  await logAudit({
    actorUserId: actor.userId,
    companyId,
    projectId,
    action: "member.app_access",
    details: `${targetUserId}: ${project.slug}=${level ?? "(none)"}`,
  });
  return { ok: true };
}

// ---------------------------------------------------------------- activity

// Who joined lately, newest first — for the panel's "X joined your
// workspace" note. Read off the audit log rows joining writes (an invite
// applied, a request approved), whose details start with the user id.
export async function recentJoins(companyId: string, limit = 20) {
  const rows = await prisma.auditLog.findMany({
    where: { companyId, action: { in: ["member.invite_applied", "member.join"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { details: true, createdAt: true },
  });
  const joins = rows.flatMap((r) => {
    const userId = r.details?.split(" ")[0];
    return userId ? [{ userId, at: r.createdAt }] : [];
  });
  const people = await Promise.all(joins.map((j) => getUserById(j.userId).catch(() => null)));
  return joins.map((j, i) => ({ userId: j.userId, name: people[i]?.name || null, email: people[i]?.email || null, at: j.at }));
}

async function sendInviteEmail(
  actor: Access,
  companyId: string,
  email: string,
  role: Role,
  access: AppAccess,
  chosenCount: number
): Promise<void> {
  const [inviter, company] = await Promise.all([
    getUserById(actor.userId).catch(() => null),
    getCompanyById(companyId).catch(() => null),
  ]);
  const input = {
    email,
    inviterName: inviter?.name || null,
    workspaceName: company?.name || "your team's workspace",
    roleName: ROLE_NAMES_FOR_EMAIL[role],
    accessSummary: role === "member" ? accessInWords(access, chosenCount) : null,
    signInUrl: `${FRONTEND_ORIGIN}/app`,
  };
  await callWebhook(Webhook.MEMBER_INVITE_EMAIL, {
    to: [{ email }],
    subject: memberInviteEmailSubject(input),
    variables: { content: renderMemberInviteEmail(input) },
  });
}
