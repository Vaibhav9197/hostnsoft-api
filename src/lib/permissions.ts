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
 *   2. What may they do there?  Ours: a WorkspaceMember row (role + app
 *      scope + two developer flags) and, for a "selected" app scope,
 *      AppGrant rows. Proxy has no readable per-user role to use instead
 *      (verified 2026-09-04, see docs/CLAUDE.md), which is why these are
 *      local tables keyed by proxy ids.
 *
 * Backward compatibility is the reason for the defaults below. Before this
 * existed every member could do everything, so a member with no row is an
 * Admin — nobody loses anything on deploy day. Each workspace gets one Owner
 * the first time its roles are worked out (ensureOwner), and someone invited
 * with a role gets it the first time they show up (applyPendingInvite).
 * Both are lazy, not a migration backfill: the facts they need (who made
 * the workspace, who is still in it, an invitee's email) live on proxy.
 *
 * The three exports at the top (PERMISSIONS, Permission, can) are a contract
 * shared with the user-tokens branch: keep their names and signatures.
 * Everything else here is free to change.
 */
import type { Project } from "@prisma/client";
import { prisma } from "./prisma";
import { isUniqueConstraintViolation } from "./prismaErrors";
import { getCompanyCreatorId, getUserById, isCompanyMember } from "./msg91";
import { logger } from "./logger";

export const PERMISSIONS = [
  "workspace.manage",
  "members.manage",
  "billing.manage",
  "tokens.manage",
  "app.create",
  "app.delete",
  "app.deploy",
  "app.settings",
  "app.view",
  "app.logs",
  "app.move",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// The one-call form, for code that has nothing cached: proxy membership,
// then role, then (with projectId) the per-app level. A projectId outside
// the workspace is a plain false, the same as "not allowed".
export async function can(
  userId: string,
  companyId: string,
  permission: Permission,
  projectId?: string
): Promise<boolean> {
  const access = await resolveAccess(userId, companyId);
  if (!access) return false;
  if (!projectId) return accessAllows(access, permission);
  const project = await prisma.project.findFirst({
    where: { id: projectId, companyId },
    select: { id: true, createdBy: true },
  });
  return !!project && accessAllows(access, permission, project);
}

// ---------------------------------------------------------------- roles

export const ROLES = ["owner", "admin", "developer", "viewer", "billing"] as const;
export type Role = (typeof ROLES)[number];
export const APP_SCOPES = ["all", "selected"] as const;
export type AppScope = (typeof APP_SCOPES)[number];
export const APP_LEVELS = ["manage", "view"] as const;
export type AppLevel = (typeof APP_LEVELS)[number];

// What a member who was already in the workspace before roles is, when they
// have no WorkspaceMember row yet. Everyone could do everything before roles,
// and Admin is "everything but billing and ownership", the closest role that
// takes nothing away that anyone was using day to day except billing — which
// Owner keeps. Someone who joins afterwards (through the proxy embed, not one
// of our invites) gets NEWCOMER_ROLE instead — see defaultRoleFor.
export const DEFAULT_ROLE: Role = "admin";
export const NEWCOMER_ROLE: Role = "developer";

const ALL = new Set<Permission>(PERMISSIONS);

// Role ceilings. For developer and viewer these are further narrowed per app
// (appLevel) and, for create/delete, by the two flags.
//
// tokens.manage for developers: a deploy token is how an AI agent acts for
// a person, and an agent's every call is checked against the token
// creator's own permissions (agent routes and the deploy claim), so a
// developer's token can never do more than the developer. What they can't
// do is touch other people's tokens — that stays with Owner/Admin
// (canManageAllTokens).
const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  admin: new Set(PERMISSIONS.filter((p) => p !== "billing.manage")),
  developer: new Set<Permission>([
    "tokens.manage",
    "app.create",
    "app.delete",
    "app.deploy",
    "app.settings",
    "app.view",
    "app.logs",
  ]),
  viewer: new Set<Permission>(["app.view", "app.logs"]),
  billing: new Set<Permission>(["billing.manage"]),
};

// Per-app permissions — the ones that need an app's level, not just a role.
const APP_PERMISSIONS = new Set<Permission>(["app.delete", "app.deploy", "app.settings", "app.view", "app.logs", "app.move"]);
// The subset a "view" level allows.
const VIEW_PERMISSIONS = new Set<Permission>(["app.view", "app.logs"]);

export function isAppPermission(permission: Permission): boolean {
  return APP_PERMISSIONS.has(permission);
}

export interface Access {
  companyId: string;
  userId: string;
  role: Role;
  // false when there's no row and DEFAULT_ROLE applies — the members page
  // says so, so an Owner can see who has never been given a role.
  explicit: boolean;
  appScope: AppScope;
  canCreate: boolean;
  canDelete: boolean;
  // Only filled for appScope "selected": projectId -> level.
  grants: Map<string, AppLevel>;
}

type ProjectRef = Pick<Project, "id" | "createdBy">;

// How far this person reaches into one app, or null for not at all.
export function appLevel(access: Access, project: ProjectRef): AppLevel | null {
  switch (access.role) {
    case "owner":
    case "admin":
      return "manage";
    case "billing":
      return null;
    case "viewer":
      return access.appScope === "all" || access.grants.has(project.id) ? "view" : null;
    case "developer":
      // An app they made is theirs to manage whatever their scope says —
      // otherwise a "selected" developer allowed to create apps would deploy
      // one and immediately be locked out of it.
      if (project.createdBy && project.createdBy === access.userId) return "manage";
      if (access.appScope === "all") return "manage";
      return access.grants.get(project.id) ?? null;
  }
}

// The pure decision, for callers that already hold an Access (middleware,
// list filtering). Without a project, an app permission answers "could they
// do this to some app" — what /me/permissions reports at workspace level.
export function accessAllows(access: Access, permission: Permission, project?: ProjectRef): boolean {
  if (!ROLE_PERMISSIONS[access.role].has(permission)) return false;

  if (permission === "app.create") return access.role !== "developer" || access.canCreate;

  if (!isAppPermission(permission)) return true;

  if (!project) {
    if (permission === "app.delete" && access.role === "developer") return access.canDelete;
    return true;
  }

  const level = appLevel(access, project);
  if (!level) return false;
  if (VIEW_PERMISSIONS.has(permission)) return true;
  if (level !== "manage") return false;

  // A developer deletes only with the flag, or an app they made themselves.
  if (permission === "app.delete" && access.role === "developer") {
    return access.canDelete || (!!project.createdBy && project.createdBy === access.userId);
  }
  return true;
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
  "app.deploy": "deploy this app",
  "app.settings": "change this app's settings",
  "app.view": "see this app",
  "app.logs": "read this app's logs",
  "app.move": "move this app to another workspace",
};

export const ROLE_NAMES: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  developer: "Developer",
  viewer: "Viewer",
  billing: "Billing",
};

// The one 403 shape, every surface. `permission` and `role` are there so a
// client can branch on them; `error` is written to be repeated to a person.
export function permissionDeniedBody(permission: Permission, access: Pick<Access, "role"> | null) {
  const role = access?.role ?? null;
  return {
    error:
      `You don't have permission to ${PERMISSION_PHRASES[permission]}` +
      (role ? ` — your role in this workspace is ${ROLE_NAMES[role]}.` : ".") +
      " A workspace Owner or Admin can change that.",
    code: "permission_denied",
    permission,
    role,
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

// null = not a member (or no such person). Writes at most once per person
// (applying their invite) and once per workspace (its first Owner).
export async function resolveAccess(
  userId: string,
  companyId: string,
  opts: ResolveOptions = {}
): Promise<Access | null> {
  if (!userId || !companyId) return null;
  if (!opts.membershipChecked && !(await isCompanyMember(userId, companyId))) return null;

  let row = await prisma.workspaceMember.findUnique({ where: { companyId_userId: { companyId, userId } } });
  if (!row) row = await applyPendingInvite(userId, companyId, opts.email);
  if (!row && (await ensureOwner(companyId, userId)) === userId) {
    row = await prisma.workspaceMember.findUnique({ where: { companyId_userId: { companyId, userId } } });
  }

  if (!row) row = await writeDefaultRole(userId, companyId);

  const role = (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : null;
  if (!role) {
    // Only this code writes the column, so this is corruption, not a
    // client error — and the safe reading of an unknown role is the
    // narrowest one.
    logger.error(`[permissions] unknown role "${row.role}" for ${userId} in ${companyId}; treating as viewer of nothing`);
  }
  const appScope: AppScope = row.appScope === "selected" ? "selected" : "all";
  const grants = new Map<string, AppLevel>();
  if (role && appScope === "selected" && (role === "developer" || role === "viewer")) {
    const rows = await prisma.appGrant.findMany({
      where: { userId, project: { companyId } },
      select: { projectId: true, level: true },
    });
    for (const g of rows) grants.set(g.projectId, g.level === "manage" ? "manage" : "view");
  }

  return {
    companyId,
    userId,
    role: role ?? "viewer",
    explicit: true,
    appScope: role ? appScope : "selected",
    canCreate: row.canCreate,
    canDelete: row.canDelete,
    grants,
  };
}

// ---------------------------------------------------------------- default role

// When roles went live: the moment this deployment applied their migration,
// read from Prisma's own record of it rather than an env var that could
// drift from what actually ran. Cached for the process — it never changes
// once set. Null only before the migration has run (a dev database), when
// everyone counts as already there.
const ROLES_MIGRATION = "20261021110000_workspace_roles";
let rolesLiveAt: Date | null | undefined;
async function rolesWentLiveAt(): Promise<Date | null> {
  if (rolesLiveAt !== undefined) return rolesLiveAt;
  const rows = await prisma
    .$queryRaw<{ finished_at: Date | string | number | null }[]>`SELECT finished_at FROM _prisma_migrations WHERE migration_name = ${ROLES_MIGRATION}`
    .catch(() => []);
  const at = rows[0]?.finished_at;
  rolesLiveAt = at == null ? null : new Date(at);
  return rolesLiveAt;
}

// Whether this person was in the workspace before roles went live. Proxy
// can't say when someone joined, so this asks what this API saw them do
// there before that moment: an app or token they made, or anything audited
// under their name (signing in to the dashboard switches company, which is
// audited). A member who never did anything here before roles reads as a
// newcomer — the cost is a Developer an Owner can promote, never an Admin
// nobody chose.
async function wasMemberBeforeRoles(userId: string, companyId: string): Promise<boolean> {
  const cutoff = await rolesWentLiveAt();
  if (!cutoff) return true;
  const before = { lt: cutoff };
  const [project, token, audit] = await Promise.all([
    prisma.project.findFirst({ where: { companyId, createdBy: userId, createdAt: before }, select: { id: true } }),
    prisma.deployToken.findFirst({ where: { companyId, createdBy: userId, createdAt: before }, select: { id: true } }),
    prisma.auditLog.findFirst({ where: { companyId, actorUserId: userId, createdAt: before }, select: { id: true } }),
  ]);
  return !!(project || token || audit);
}

// A member with no row and no invite gets one now, so their role is
// decided once and doesn't flip later: Admin if they were already here
// before roles (nobody loses anything), else a Developer on all apps — what
// someone added straight through the proxy embed, skipping our invite,
// should get without anyone having chosen more for them.
async function writeDefaultRole(userId: string, companyId: string) {
  const existing = await wasMemberBeforeRoles(userId, companyId);
  const role = existing ? DEFAULT_ROLE : NEWCOMER_ROLE;
  try {
    const row = await prisma.workspaceMember.create({
      data: { companyId, userId, role, appScope: "all", canCreate: true, canDelete: role !== "developer" },
    });
    await prisma.auditLog.create({
      data: {
        actorUserId: null,
        companyId,
        action: "member.role_change",
        details: `${userId}: (none) -> ${role} — default, ${existing ? "member before roles" : "joined after roles"}`,
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
// (the members page): give each confirmed member their row the same way
// resolveAccess would, so the role shown is the one they will have.
// The caller must already know they are a member.
export async function ensureMemberRow(userId: string, companyId: string, email?: string | null) {
  const row = await prisma.workspaceMember.findUnique({ where: { companyId_userId: { companyId, userId } } });
  if (row) return row;
  return (await applyPendingInvite(userId, companyId, email)) ?? writeDefaultRole(userId, companyId);
}

// ---------------------------------------------------------------- first owner

// Workspaces known to have an Owner row, so the check below is one query per
// workspace per process rather than one per row-less member's request. Only
// an optimisation: nothing this API does takes a workspace from one Owner to
// none (workspaceRoles.ts refuses it), so a stale "yes" can't be wrong.
const workspacesWithOwner = new Set<string>();

// System ids that appear in createdBy columns but are nobody.
function isPersonId(id: string | null | undefined): id is string {
  return !!id && id !== "hostnsoft-deploy" && !id.startsWith("system:");
}

// Gives a workspace its first Owner, once. Returns the user id it just made
// Owner, or null when the workspace already had one. Picked, best evidence
// first:
//
//   1. whoever proxy says created the workspace (created_by, unverified
//      field — see msg91.ts getCompanyCreatorId), if still a member;
//   2. the earliest person this API has on record acting in it — first app,
//      first deploy token, first audit row — who is still a member;
//   3. failing both, the person whose request got here first.
//
// (3) can make a member who wasn't the creator an Owner. Before roles every
// member already had every power, so what it adds is billing and the say
// over Admins — and that Owner can make the real creator an Owner too. The
// reason is written to the audit row so it's findable.
//
// Not a transaction: two first requests racing can, at worst, both write an
// Owner — two Owners, which is a legal state — and the unique index stops a
// person getting two rows.
export async function ensureOwner(companyId: string, callerId: string): Promise<string | null> {
  if (workspacesWithOwner.has(companyId)) return null;
  if (await prisma.workspaceMember.count({ where: { companyId, role: "owner" } })) {
    workspacesWithOwner.add(companyId);
    return null;
  }

  let ownerId: string | null = null;
  let reason = "";

  const creator = await getCompanyCreatorId(companyId).catch(() => null);
  if (creator && (creator === callerId || (await isCompanyMember(creator, companyId).catch(() => false)))) {
    ownerId = creator;
    reason = "created the workspace";
  }

  if (!ownerId) {
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
    const candidates = [...new Set(seen.map((c) => c.id))].slice(0, 5);
    for (const id of candidates) {
      if (id === callerId || (await isCompanyMember(id, companyId).catch(() => false))) {
        ownerId = id;
        reason = "earliest member on record";
        break;
      }
    }
  }

  if (!ownerId) {
    ownerId = callerId;
    reason = "first member to sign in after roles were introduced";
  }

  // A row they already have (an applied invite) is promoted rather than
  // duplicated; it can only exist here if it isn't an owner row.
  await prisma.workspaceMember.upsert({
    where: { companyId_userId: { companyId, userId: ownerId } },
    update: { role: "owner" },
    create: { companyId, userId: ownerId, role: "owner" },
  });
  await prisma.auditLog.create({
    data: {
      actorUserId: null,
      companyId,
      action: "member.role_change",
      details: `${ownerId}: (none) -> owner — first Owner, ${reason}`,
    },
  });
  workspacesWithOwner.add(companyId);
  logger.info(`[permissions] ${companyId}: ${ownerId} made first Owner (${reason})`);
  return ownerId;
}

// ---------------------------------------------------------------- invites

export interface InviteGrant {
  projectId: string;
  level: AppLevel;
}

export function parseInviteGrants(raw: string): InviteGrant[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((g) =>
      g && typeof g.projectId === "string" && (g.level === "manage" || g.level === "view")
        ? [{ projectId: g.projectId, level: g.level as AppLevel }]
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
        appScope: invite.appScope,
        canCreate: invite.canCreate,
        canDelete: invite.canDelete,
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
      details: `${userId} (${email}) joined as ${invite.role}${invite.appScope === "selected" ? `, ${liveIds.size} app(s)` : ""}`,
    },
  });
  if (invite.role === "owner") workspacesWithOwner.add(companyId);
  return row;
}
