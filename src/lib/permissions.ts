/**
 * Who may do what inside a workspace — the role layer on top of proxy
 * membership. See docs/CLAUDE.md "Authorization".
 *
 * Two questions, answered by two systems, in this order:
 *
 *   1. Is this person in the workspace at all?  Proxy (isCompanyMember),
 *      asked fresh on every request. Removing someone there cuts them off
 *      immediately, whatever rows exist here — so a stale WorkspaceMember
 *      row can never keep a departed person in.
 *   2. What may they do there?  Ours: a WorkspaceMember row (the
 *      workspace role) and, for a Member, AppGrant rows (their access to
 *      particular projects above the default "use"). Proxy has no readable per-user role to use instead
 *      (verified 2026-09-04, see docs/CLAUDE.md), which is why these are
 *      local tables keyed by proxy ids.
 *
 * Backward compatibility is the reason for the defaults below. Before this
 * existed every member could do everything, so everyone in a workspace when
 * its roles are set up becomes an Admin and its creator its Owner
 * (setUpWorkspaceRoles: on its first request, and in a sweep at startup) —
 * nobody loses anything on deploy day. Until then a member with no row
 * counts as an Admin. Someone invited with a role gets it the first time
 * they show up (applyPendingInvite). None of this is a migration backfill:
 * the facts it needs (who made the workspace, who is in it, an invitee's
 * email) live on proxy.
 *
 * The three exports at the top (PERMISSIONS, Permission, can) are a contract
 * shared with the user-tokens branch: keep their names and signatures.
 * Everything else here is free to change.
 */
import type { Project } from "@prisma/client";
import { prisma } from "./prisma";
import { isUniqueConstraintViolation } from "./prismaErrors";
import { getCompanyCreatorId, getUserById, isCompanyMember, listCompanyMembers } from "./msg91";
import { logger } from "./logger";

export const PERMISSIONS = [
  "workspace.manage",
  // Invite people, change roles and per-app access. Owner and Admin only.
  "members.manage",
  "billing.manage",
  "tokens.manage",
  "app.create",
  "app.delete",
  // Publishing: putting a new version live (deploy, rollback, applying env
  // vars). Full access only — "nothing changes in production before
  // approval", and approving is publishing.
  "app.deploy",
  "app.settings",
  "app.view",
  "app.logs",
  "app.move",
  // Have an AI make changes as a preview for someone with full access to
  // approve. Previews aren't built yet: reported by /me/permissions so
  // clients can show it; no route checks it yet.
  "app.edit",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// The one-call form, for code that has nothing cached: proxy membership,
// then role, then (with projectId) the project's access level. A projectId
// outside the workspace is a plain false, the same as "not allowed".
export async function can(
  userId: string,
  companyId: string,
  permission: Permission,
  projectId?: string,
  opts: ResolveOptions = {}
): Promise<boolean> {
  const access = await resolveAccess(userId, companyId, opts);
  if (!access) return false;
  if (!projectId) return accessAllows(access, permission);
  const project = await prisma.project.findFirst({
    where: { id: projectId, companyId },
    select: { id: true, createdBy: true },
  });
  return !!project && accessAllows(access, permission, project);
}

// ---------------------------------------------------------------- roles

// Workspace roles. Member is everyone who isn't running the workspace:
// what they can do to each project is its access level, not their job title
// — a finance or sales person contributes through their AI as much as an
// engineer does.
export const ROLES = ["owner", "admin", "member", "billing"] as const;
export type Role = (typeof ROLES)[number];

// Project access, lowest first; each includes the one below. Told apart by
// what happens to the live app:
//   use   use it, its Context and history, comment — nothing changes
//   edit  + have their AI make changes as a preview, read logs so the AI
//           can fix things — nothing changes until someone with full
//           access approves
//   full  + approve and publish, restore a version, settings and
//           secrets, domains, share, delete, move — they change it
export const ACCESS_LEVELS = ["use", "edit", "full"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

const LEVEL_PERMISSIONS: Record<AccessLevel, ReadonlySet<Permission>> = (() => {
  const use: Permission[] = ["app.view"];
  const edit: Permission[] = [...use, "app.logs", "app.edit"];
  const full: Permission[] = [...edit, "app.deploy", "app.settings", "app.delete", "app.move"];
  return { use: new Set(use), edit: new Set(edit), full: new Set(full) };
})();

// What a Member reaches on a project nobody gave them access to: they can
// find and use everything the company built.
export const MEMBER_DEFAULT_LEVEL: AccessLevel = "use";

// What a member who was already in the workspace before roles is. Everyone
// could do everything before roles, and Admin still can (only managing
// Owners and Admins is Owner-only), so nobody loses anything. Someone who
// joins after their workspace's members were captured (through the proxy
// embed, not one of our invites) gets NEWCOMER_ROLE instead — see
// setUpWorkspaceRoles and defaultRow.
export const DEFAULT_ROLE: Role = "admin";
export const NEWCOMER_ROLE: Role = "member";

const ALL = new Set<Permission>(PERMISSIONS);

// Per-project permissions — the ones decided by a project's access level.
const APP_PERMISSIONS = new Set<Permission>(PERMISSIONS.filter((p) => p.startsWith("app.") && p !== "app.create"));

export function isAppPermission(permission: Permission): boolean {
  return APP_PERMISSIONS.has(permission);
}

// Role ceilings; a Member's app permissions are then narrowed per project.
//
// tokens.manage for members: a deploy token is how an AI acts for a
// person, and its every call is checked against that person's own access
// (agent routes and the deploy claim), so a member's token can never do
// more than the member. What they can't do is touch other people's tokens —
// that stays with Owner/Admin (canManageAllTokens).
//
// app.create for members: anyone can put something new online, and gets
// full access on what they made (projectLevel).
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  // Admin differs from Owner only in who may make, change or remove Owners
  // and Admins (services/workspaceRoles.ts) — billing included, so the
  // person paying never depends on which member was picked Owner.
  owner: ALL,
  admin: ALL,
  member: new Set<Permission>(["tokens.manage", "app.create", ...APP_PERMISSIONS]),
  billing: new Set<Permission>(["billing.manage"]),
};

export interface Access {
  companyId: string;
  userId: string;
  role: Role;
  // false when there's no row and DEFAULT_ROLE applies — the members page
  // says so, so an Owner can see who has never been given a role.
  explicit: boolean;
  // A Member's level on projects with no grant; null for none (a role
  // this code doesn't recognise reads as reaching nothing).
  defaultLevel: AccessLevel | null;
  // A Member's per-project grants: projectId -> level.
  grants: Map<string, AccessLevel>;
}

type ProjectRef = Pick<Project, "id" | "createdBy">;

function higher(a: AccessLevel | null | undefined, b: AccessLevel | null | undefined): AccessLevel | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return ACCESS_LEVELS.indexOf(a) >= ACCESS_LEVELS.indexOf(b) ? a : b;
}

// This person's access to one project, or null for none at all.
export function projectLevel(access: Access, project: ProjectRef): AccessLevel | null {
  switch (access.role) {
    case "owner":
    case "admin":
      return "full";
    case "billing":
      return null;
    case "member":
      // What they made is theirs, whatever else applies.
      if (project.createdBy && project.createdBy === access.userId) return "full";
      return higher(access.grants.get(project.id), access.defaultLevel);
  }
}

// The pure decision, for callers that already hold an Access (middleware,
// list filtering). Without a project, an app permission answers "could they
// do this to some project" — what /me/permissions reports at workspace
// level; a Member always could, on a project they create.
export function accessAllows(access: Access, permission: Permission, project?: ProjectRef): boolean {
  if (!ROLE_PERMISSIONS[access.role].has(permission)) return false;
  if (!isAppPermission(permission) || !project) return true;
  const level = projectLevel(access, project);
  return !!level && LEVEL_PERMISSIONS[level].has(permission);
}

export function canManageAllTokens(access: Access): boolean {
  return access.role === "owner" || access.role === "admin";
}

// Everything allowed at workspace level, for /me/permissions.
export function allowedPermissions(access: Access, project?: ProjectRef): Permission[] {
  return PERMISSIONS.filter((p) => (project ? isAppPermission(p) : true) && accessAllows(access, p, project));
}

// Plain-language phrases for the 403 body, so an agent can relay it to the
// person as-is. See app/lib/guide/content.js "permission_denied".
export const PERMISSION_PHRASES: Record<Permission, string> = {
  "workspace.manage": "change this workspace's settings",
  "members.manage": "change who is in this workspace or what they can do",
  "billing.manage": "manage this workspace's plan and billing",
  "tokens.manage": "create or remove deploy tokens",
  "app.create": "add new apps to this workspace",
  "app.delete": "delete this app",
  "app.deploy": "publish this app (that needs full access to it)",
  "app.settings": "change this app's settings (that needs full access to it)",
  "app.view": "see this app",
  "app.logs": "read this app's logs",
  "app.move": "move this app to another workspace",
  "app.edit": "make changes to this app",
};

export const ROLE_NAMES: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  billing: "Billing",
};

export const LEVEL_NAMES: Record<AccessLevel, string> = {
  use: "Can use",
  edit: "Can edit",
  full: "Full access",
};

// The one 403 shape, every surface. `permission` and `role` are there so a
// client can branch on them; `error` is written to be repeated to a person,
// and names their access to the project when there is one.
export function permissionDeniedBody(
  permission: Permission,
  access: Access | Pick<Access, "role"> | null,
  project?: ProjectRef
) {
  const role = access?.role ?? null;
  const level = access && project && "grants" in access ? projectLevel(access, project) : null;
  const yours = level
    ? ` — your access to this app is "${LEVEL_NAMES[level]}".`
    : role
      ? ` — your role in this workspace is ${ROLE_NAMES[role]}.`
      : ".";
  return {
    error:
      `You don't have permission to ${PERMISSION_PHRASES[permission]}${yours}` +
      " A workspace Owner or Admin can change that.",
    code: "permission_denied",
    permission,
    role,
    ...(level ? { access: level } : {}),
  };
}

// ---------------------------------------------------------------- resolve

export interface ResolveOptions {
  // loadCompanyContext already asked proxy this request; asking twice
  // would only double the proxy calls on every dashboard route.
  membershipChecked?: boolean;
  // The person's email when the caller already has it (the PAT identity),
  // so a pending invite can be matched without an extra proxy lookup.
  email?: string | null;
}

function toLevel(raw: string): AccessLevel | null {
  return (ACCESS_LEVELS as readonly string[]).includes(raw) ? (raw as AccessLevel) : null;
}

// null = not a member (or no such person). Writes at most once per person
// (applying their invite, or their Member row once the workspace is set up).
export async function resolveAccess(
  userId: string,
  companyId: string,
  opts: ResolveOptions = {}
): Promise<Access | null> {
  if (!userId || !companyId) return null;
  if (!opts.membershipChecked && !(await isCompanyMember(userId, companyId))) return null;

  // Finishes this workspace's one-time setup in the background if it isn't
  // done yet; this request never waits for proxy on its account.
  void startSetUp(companyId);

  let stored = await prisma.workspaceMember.findUnique({ where: { companyId_userId: { companyId, userId } } });
  if (!stored) stored = await applyPendingInvite(userId, companyId, opts.email);
  const explicit = !!stored;
  const row: MemberRole = stored ?? (await defaultRow(userId, companyId));

  const role = (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : null;
  if (!role) {
    // Only this code writes the column, so this is corruption, not a
    // client error — and the safe reading of an unknown role is the
    // narrowest one.
    logger.error(`[permissions] unknown role "${row.role}" for ${userId} in ${companyId}; treating as a member who reaches nothing`);
  }

  const grants = new Map<string, AccessLevel>();
  if (role === "member" || !role) {
    const rows = await prisma.appGrant.findMany({
      where: { userId, project: { companyId } },
      select: { projectId: true, level: true },
    });
    for (const g of rows) {
      const level = toLevel(g.level);
      if (level) grants.set(g.projectId, level);
    }
  }

  return {
    companyId,
    userId,
    role: role ?? "member",
    explicit,
    defaultLevel: role === "member" ? MEMBER_DEFAULT_LEVEL : null,
    grants,
  };
}

// ---------------------------------------------------------------- default role

// The role fields resolveAccess reads, whether stored or defaulted.
type MemberRole = { role: string };

// A member with no row and no invite. Before their workspace's members were
// captured (setUpWorkspaceRoles), they may have been there before roles
// existed, so they count as an Admin — computed, not written, so the capture
// can still record them as what they are. After it, anyone without a row
// joined later, and is written once as a Member.
async function defaultRow(userId: string, companyId: string): Promise<MemberRole> {
  if (await membersCaptured(companyId)) return writeNewcomerRow(userId, companyId);
  return { role: DEFAULT_ROLE };
}

async function writeNewcomerRow(userId: string, companyId: string) {
  try {
    const row = await prisma.workspaceMember.create({
      data: { companyId, userId, role: NEWCOMER_ROLE },
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: null,
        companyId,
        action: "member.role_change",
        details: `${userId}: (none) -> ${NEWCOMER_ROLE} — default, joined after roles were set up`,
      },
    });
    return row;
  } catch (err) {
    // Two first requests racing: the other one wrote it.
    if (!isUniqueConstraintViolation(err)) throw err;
    return prisma.workspaceMember.findUniqueOrThrow({ where: { companyId_userId: { companyId, userId } } });
  }
}

// For lists that show people before they've made a request of their own
// (the members page): their stored row, an invite applied, or — once the
// workspace's members are captured — their Member row. Null means they
// count as DEFAULT_ROLE without a row. The caller must already know they are
// a member.
export async function ensureMemberRow(userId: string, companyId: string, email?: string | null) {
  const row = await prisma.workspaceMember.findUnique({ where: { companyId_userId: { companyId, userId } } });
  if (row) return row;
  const invited = await applyPendingInvite(userId, companyId, email);
  if (invited) return invited;
  return (await membersCaptured(companyId)) ? writeNewcomerRow(userId, companyId) : null;
}

// ---------------------------------------------------------------- workspace setup

// Workspaces whose setup is complete (owner decided, members captured). Both
// only ever go from unset to set, so a cached "done" can't go stale.
const setUpDone = new Set<string>();
const capturedDone = new Set<string>();
const setUpRunning = new Map<string, Promise<void>>();
const lastSetUpTry = new Map<string, number>();
// How soon a workspace whose setup couldn't finish (proxy down, or no
// trustworthy member list) is tried again by this process.
const SET_UP_RETRY_MS = 10 * 60 * 1000;

async function membersCaptured(companyId: string): Promise<boolean> {
  if (capturedDone.has(companyId)) return true;
  const row = await prisma.workspaceRoleSetup.findUnique({ where: { companyId }, select: { membersCapturedAt: true } });
  if (row?.membersCapturedAt) capturedDone.add(companyId);
  return !!row?.membersCapturedAt;
}

// Runs the setup unless it's done, already running, or failed a moment ago.
// Never throws; the promise is for callers that want to wait (the members
// page). Null when there's nothing to wait for.
export function startSetUp(companyId: string): Promise<void> | null {
  if (setUpDone.has(companyId)) return null;
  const running = setUpRunning.get(companyId);
  if (running) return running;
  if (Date.now() - (lastSetUpTry.get(companyId) ?? 0) < SET_UP_RETRY_MS) return null;
  lastSetUpTry.set(companyId, Date.now());

  const run = setUpWorkspaceRoles(companyId)
    .catch((err) => logger.warn(`[permissions] ${companyId}: roles setup failed, will retry: ${(err as Error)?.message}`))
    .finally(() => setUpRunning.delete(companyId));
  setUpRunning.set(companyId, run);
  return run;
}

/**
 * A workspace's one-time move to roles (schema.prisma WorkspaceRoleSetup):
 *
 *   1. members: everyone proxy lists as in it now is written as an Admin —
 *      what every member effectively was before roles. Needs a trustworthy
 *      list (msg91.ts listCompanyMembers); without one nothing is written
 *      and it's tried again later, while row-less members count as Admin.
 *   2. owner: whoever made the workspace, when proxy names them and they're
 *      still a member; else the earliest member on record here; else nobody
 *      (an Admin may then make someone Owner, see workspaceRoles.ts). A
 *      proxy error stops this step — it's retried, never guessed past.
 *
 * Each step is recorded once done; the other can still finish later.
 * Idempotent and safe to run concurrently: rows are upserts that never
 * overwrite a role someone already has.
 */
export async function setUpWorkspaceRoles(companyId: string): Promise<void> {
  const before = await prisma.workspaceRoleSetup.findUnique({ where: { companyId } });
  let ownerDecidedAt = before?.ownerDecidedAt ?? null;
  let membersCapturedAt = before?.membersCapturedAt ?? null;

  let members: { id: string }[] | null = null;
  let ownerError: unknown = null;
  if (!membersCapturedAt) {
    members = await listCompanyMembers(companyId);
    if (members) {
      await prisma.$transaction(
        members.map((m) =>
          prisma.workspaceMember.upsert({
            where: { companyId_userId: { companyId, userId: m.id } },
            update: {},
            create: { companyId, userId: m.id, role: DEFAULT_ROLE },
          })
        )
      );
      membersCapturedAt = new Date();
      await prisma.auditLog.create({
        data: {
          actorUserId: null,
          companyId,
          action: "member.role_change",
          details: `${members.length} existing member(s): (none) -> ${DEFAULT_ROLE} — members when roles were set up`,
        },
      });
    }
  }

  if (!ownerDecidedAt) {
    // A proxy error leaves this step undone, to be retried — what step 1
    // did is still recorded below before the error is reported.
    try {
      await decideOwner(companyId, members);
      ownerDecidedAt = new Date();
    } catch (err) {
      ownerError = err;
    }
  }

  await prisma.workspaceRoleSetup.upsert({
    where: { companyId },
    update: { ownerDecidedAt, membersCapturedAt },
    create: { companyId, ownerDecidedAt, membersCapturedAt },
  });
  if (membersCapturedAt) capturedDone.add(companyId);
  if (ownerDecidedAt && membersCapturedAt) setUpDone.add(companyId);
  if (ownerError) throw ownerError;
}

// Step 2 of setUpWorkspaceRoles. Nothing to do if the workspace already
// has an Owner (made at creation, or by an applied invite). Throws on a
// proxy error.
async function decideOwner(companyId: string, members: { id: string }[] | null): Promise<void> {
  if (await prisma.workspaceMember.count({ where: { companyId, role: "owner" } })) return;
  const pick = await pickOwner(companyId, members);
  if (!pick) {
    logger.warn(`[permissions] ${companyId}: no Owner could be determined; an Admin may name one`);
    return;
  }
  await prisma.workspaceMember.upsert({
    where: { companyId_userId: { companyId, userId: pick.id } },
    update: { role: "owner" },
    create: { companyId, userId: pick.id, role: "owner" },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId: null,
      companyId,
      action: "member.role_change",
      details: `${pick.id}: -> owner — first Owner, ${pick.reason}`,
    },
  });
  logger.info(`[permissions] ${companyId}: ${pick.id} made first Owner (${pick.reason})`);
}

// System ids that appear in createdBy columns but are nobody.
function isPersonId(id: string | null | undefined): id is string {
  return !!id && id !== "hostnsoft-deploy" && !id.startsWith("system:");
}

// The workspace's first Owner, or null when nobody qualifies. `members` is
// the captured list when there is one, saving a membership call per
// candidate. Proxy errors propagate (see setUpWorkspaceRoles).
async function pickOwner(
  companyId: string,
  members: { id: string }[] | null
): Promise<{ id: string; reason: string } | null> {
  const isMember = async (id: string) =>
    members ? members.some((m) => m.id === id) : isCompanyMember(id, companyId);

  const creator = await getCompanyCreatorId(companyId);
  if (creator && (await isMember(creator))) return { id: creator, reason: "created the workspace" };

  const [projects, tokens, audits] = await Promise.all([
    prisma.project.findMany({ where: { companyId }, orderBy: { createdAt: "asc" }, take: 5, select: { createdBy: true, createdAt: true } }),
    prisma.deployToken.findMany({ where: { companyId }, orderBy: { createdAt: "asc" }, take: 5, select: { createdBy: true, createdAt: true } }),
    prisma.auditLog.findMany({
      where: { companyId, actorUserId: { not: null } },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: { actorUserId: true, createdAt: true },
    }),
  ]);
  const seen = [
    ...projects.map((p) => ({ id: p.createdBy, at: p.createdAt })),
    ...tokens.map((t) => ({ id: t.createdBy, at: t.createdAt })),
    ...audits.map((a) => ({ id: a.actorUserId, at: a.createdAt })),
  ]
    .filter((c): c is { id: string; at: Date } => isPersonId(c.id))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const id of [...new Set(seen.map((c) => c.id))].slice(0, 5)) {
    if (await isMember(id)) {
      return { id, reason: creator ? "earliest member on record (the creator has left)" : "earliest member on record (proxy names no creator)" };
    }
  }
  return null;
}

// Sets up every workspace this API knows of, one at a time, shortly after
// startup — so roles are in place before most people's next request, and
// the members page shows real roles. Repeats every start for any workspace
// that couldn't finish; finished ones cost one query each.
export function startRolesSetupSweep(delayMs = 20_000): void {
  setTimeout(async () => {
    try {
      const [companies, projects, tokens] = await Promise.all([
        prisma.company.findMany({ select: { id: true } }),
        prisma.project.findMany({ where: { companyId: { not: null } }, distinct: ["companyId"], select: { companyId: true } }),
        prisma.deployToken.findMany({ distinct: ["companyId"], select: { companyId: true } }),
      ]);
      const ids = new Set<string>([
        ...companies.map((c) => c.id),
        ...projects.map((p) => p.companyId!),
        ...tokens.map((t) => t.companyId),
      ]);
      const done = await prisma.workspaceRoleSetup.findMany({
        where: { ownerDecidedAt: { not: null }, membersCapturedAt: { not: null } },
        select: { companyId: true },
      });
      for (const d of done) {
        setUpDone.add(d.companyId);
        capturedDone.add(d.companyId);
        ids.delete(d.companyId);
      }
      logger.info(`[permissions] roles setup sweep: ${ids.size} workspace(s) to set up`);
      for (const id of ids) {
        await startSetUp(id);
        await new Promise((r) => setTimeout(r, 200));
      }
      logger.info(`[permissions] roles setup sweep finished`);
    } catch (err) {
      logger.error(`[permissions] roles setup sweep failed: ${(err as Error)?.message}`);
    }
  }, delayMs).unref();
}

// ---------------------------------------------------------------- invites

export interface InviteGrant {
  projectId: string;
  level: AccessLevel;
}

export function parseInviteGrants(raw: string): InviteGrant[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((g) =>
      g && typeof g.projectId === "string" && toLevel(g.level)
        ? [{ projectId: g.projectId, level: g.level as AccessLevel }]
        : []
    );
  } catch {
    return [];
  }
}

// Turns a role chosen at invite time into the member's row, the first time
// their permissions are worked out as a member — i.e. on their first
// request into the workspace, from any surface. Here rather than at login
// because login knows only proxy's *current* company, and an invite is for a
// particular one; and because a person invited to a workspace they're
// already signed in to never logs in again.
//
// Cheap when there's nothing to apply: one indexed count, and the proxy
// email lookup only when the workspace has invites outstanding.
async function applyPendingInvite(userId: string, companyId: string, knownEmail?: string | null) {
  const outstanding = await prisma.pendingInvite.count({ where: { companyId } });
  if (outstanding === 0) return null;

  const email = (knownEmail ?? (await getUserById(userId).catch(() => null))?.email ?? null)?.toLowerCase();
  if (!email) return null;

  const invite = await prisma.pendingInvite.findUnique({ where: { companyId_email: { companyId, email } } });
  if (!invite) return null;

  const grants = parseInviteGrants(invite.grants);
  const live = grants.length
    ? await prisma.project.findMany({ where: { companyId, id: { in: grants.map((g) => g.projectId) } }, select: { id: true } })
    : [];
  const liveIds = new Set(live.map((p) => p.id));

  const [row] = await prisma.$transaction([
    prisma.workspaceMember.upsert({
      where: { companyId_userId: { companyId, userId } },
      update: {},
      create: {
        companyId,
        userId,
        role: invite.role,
      },
    }),
    ...grants
      .filter((g) => liveIds.has(g.projectId))
      .map((g) =>
        prisma.appGrant.upsert({
          where: { projectId_userId: { projectId: g.projectId, userId } },
          update: { level: g.level },
          create: { projectId: g.projectId, userId, level: g.level },
        })
      ),
    prisma.pendingInvite.delete({ where: { id: invite.id } }),
  ]);

  await prisma.auditLog.create({
    data: {
      actorUserId: invite.invitedBy,
      companyId,
      action: "member.invite_applied",
      details: `${userId} (${email}) joined as ${invite.role}${liveIds.size ? `, access to ${liveIds.size} app(s)` : ""}`,
    },
  });
  return row;
}
