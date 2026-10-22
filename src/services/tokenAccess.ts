/**
 * May this caller act on this app? — for every caller that is NOT a person
 * on a dashboard route (those go through loadCompanyContext +
 * loadProjectContext, addressed by the URL's own workspace).
 *
 * The callers here address an app by its id or its name, and neither says
 * which workspace it is in, so the answer depends on what the credential
 * may reach:
 *
 *   workspace kind — a workspace token, or a dashboard upload (a person, but
 *     scoped to the one workspace their upload names): its own workspace's
 *     apps, and nothing else. Exactly the rule every token had until user
 *     tokens existed, and no proxy call to reach it.
 *   user kind — a token that acts as the person who made it: any app in a
 *     workspace where can() says that person may do this. Asked live, every
 *     call, so a removed member's token stops the moment they are removed.
 *
 * Looking an app up by NAME across workspaces is safe because names are
 * unique platform-wide (Project.slug, and SlugAlias for old names): there is
 * at most one app a name can mean, so "find it anywhere, then check access"
 * can never pick the wrong one. The id is the primary path anyway.
 *
 * Three outcomes, not two. Refused callers fall into two groups that must be
 * told different things: one that has a stake in this app (it moved away
 * from them, or they lost access to its workspace) gets an explanation and
 * the next step — app_moved or no_access — while a stranger gets whatever
 * the route said before this existed (404, or app_name_taken on a deploy),
 * so an app name or id is never a way to learn whose app it is.
 */
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { accessAllows, can, permissionDeniedBody, resolveAccess, type Permission } from "../lib/permissions";
import { getCompanyById } from "../lib/msg91";
import { logger } from "../lib/logger";
import type { TokenActor } from "./deployTokenAuth";

// Written twice per move, once in each workspace (services/projectMove.ts),
// with details {from, to} as company ids. The row in the OLD workspace is
// what lets that workspace's tokens be told "it moved" rather than "no such
// app" — see wasMovedOutOf.
export const PROJECT_MOVE_ACTION = "project.move";

export type AccessActor = {
  kind: "user" | "workspace";
  // Workspace kind: the only workspace it reaches. User kind: the default
  // workspace, where its new apps go.
  companyId: string;
  // Who to check with can(). Null only for a workspace-kind caller with
  // nobody behind it, which never needs one.
  userId: string | null;
};

export function accessActorOf(token: TokenActor): AccessActor {
  return { kind: token.kind, companyId: token.companyId, userId: token.userId };
}

export type AccessRefusal = {
  status: 403 | 409;
  code: "no_access" | "app_moved" | "permission_denied";
  reason: string;
};

// Same shape as projectClaim.ts's app_renamed notice, with from/to optional:
// they are workspace NAMES, given only to a caller in both workspaces.
export type MovedNotice = { code: "app_moved"; from?: string; to?: string; detail: string };

export type AppAccess =
  | { ok: true; notice: MovedNotice | null }
  // refusal null: a stranger to this app. The caller answers exactly as it
  // did before user tokens existed.
  | { ok: false; refusal: AccessRefusal | null };

// For messages only. The verb reads after "can't".
const VERB: Partial<Record<Permission, string>> = {
  "app.create": "create apps",
  "app.deploy": "deploy apps",
  "app.view": "see apps",
  "app.logs": "read app logs",
  "app.settings": "change apps",
  "app.delete": "delete apps",
  "app.move": "move apps",
};

async function workspaceName(companyId: string): Promise<string | null> {
  // A name makes the message better; its absence must not fail the call.
  try {
    return (await getCompanyById(companyId))?.name ?? null;
  } catch (e) {
    logger.warn(`[tokenAccess] could not read workspace name for ${companyId}: ${(e as Error).message}`);
    return null;
  }
}

/** This app has left `companyId` (the caller checks it isn't there now). */
async function wasMovedOutOf(projectId: string, companyId: string): Promise<boolean> {
  const row = await prisma.auditLog.findFirst({
    where: { projectId, companyId, action: PROJECT_MOVE_ACTION },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The app moved away from a workspace this person can still reach — so it
 * was theirs to work on until the move took it out of reach. Ordered by
 * recency so the usual case (one move) costs one membership check.
 */
async function movedAwayFromReach(actor: AccessActor, project: Project): Promise<boolean> {
  const rows = await prisma.auditLog.findMany({
    where: { projectId: project.id, action: PROJECT_MOVE_ACTION, companyId: { not: project.companyId } },
    orderBy: { createdAt: "desc" },
    select: { companyId: true },
    take: 10,
  });
  const seen = new Set<string>();
  for (const { companyId } of rows) {
    if (!companyId || seen.has(companyId)) continue;
    seen.add(companyId);
    if (companyId === actor.companyId) return true;
    if (actor.userId && (await can(actor.userId, companyId, "app.view"))) return true;
  }
  return false;
}

/**
 * Whether naming this workspace to this caller tells them nothing new: it is
 * the token's own, or they can still see into it (a member whose role lacks
 * the permission), or they have acted in it before (a member since removed —
 * exactly who no_access is for). A stranger gets no name, and no refusal.
 */
async function knowsWorkspace(actor: AccessActor, companyId: string): Promise<boolean> {
  if (companyId === actor.companyId) return true;
  if (!actor.userId) return false;
  if (await can(actor.userId, companyId, "app.view")) return true;
  const acted = await prisma.auditLog.findFirst({
    where: { actorUserId: actor.userId, companyId },
    select: { id: true },
  });
  return acted !== null;
}

async function noAccess(companyId: string, permission: Permission): Promise<AccessRefusal> {
  const name = await workspaceName(companyId);
  const where = name ? `the workspace "${name}"` : "this app's workspace";
  const ask = name ? `"${name}"` : "that workspace";
  return {
    status: 403,
    code: "no_access",
    reason:
      `The person this token belongs to can't ${VERB[permission] ?? "do that"} in ${where}. ` +
      `Ask them to get access from someone who manages ${ask}, or for a deploy token from that workspace. Nothing was changed.`,
  };
}

function appMoved(actor: AccessActor, appName?: string): AccessRefusal {
  const app = appName ? `The app "${appName}"` : "This app";
  // Never the target's name or id: an old-workspace caller learns only that
  // it went somewhere else.
  const next =
    actor.kind === "workspace"
      ? "This workspace's token can't deploy or change it any more. Use a personal deploy token of someone with access to the workspace it moved to, or ask the person who moved it for access."
      : "The person this token belongs to isn't in that workspace. Ask someone there to add them, then deploy again with the same token.";
  return {
    status: 409,
    code: "app_moved",
    reason: `${app} was moved to another workspace. ${next} Nothing was deployed or changed, and no copy was made.`,
  };
}

/**
 * Tell a user-token caller the app moved — once: only while nothing has been
 * deployed to the app since the move, the same "it changed outside this
 * deploy" trigger as app_renamed. Workspace callers in the app's new
 * workspace get nothing: for them the app was always there.
 */
async function movedNotice(actor: AccessActor, project: Project): Promise<MovedNotice | null> {
  if (actor.kind !== "user" || !actor.userId || !project.companyId) return null;
  const move = await prisma.auditLog.findFirst({
    where: { projectId: project.id, companyId: project.companyId, action: PROJECT_MOVE_ACTION },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  if (!move) return null;
  const since = await prisma.deployment.findFirst({
    where: { projectId: project.id, createdAt: { gt: move.createdAt } },
    select: { id: true },
  });
  if (since) return null;

  let fromId: string | null = null;
  try {
    fromId = (JSON.parse(move.details ?? "{}") as { from?: string }).from ?? null;
  } catch {
    // A malformed row only costs the names.
  }
  // Names only when the caller is in both: they could read both anyway.
  const names =
    fromId && (await can(actor.userId, fromId, "app.view"))
      ? { from: await workspaceName(fromId), to: await workspaceName(project.companyId) }
      : null;
  if (names?.from && names.to) {
    return {
      code: "app_moved",
      from: names.from,
      to: names.to,
      detail:
        `This app was moved from the workspace "${names.from}" to "${names.to}" outside this deploy, so this deploy updated it in "${names.to}". ` +
        `Its address and appId are unchanged; keep using them.`,
    };
  }
  return {
    code: "app_moved",
    detail:
      "This app was moved to a different workspace outside this deploy, and this deploy updated it there. " +
      "Its address and appId are unchanged; keep using them.",
  };
}

/**
 * The decision for an existing, claimed app. `appName` is the name the
 * caller used, for the message; `notice` asks for the app_moved notice
 * (deploys only).
 */
export async function checkAppAccess(
  actor: AccessActor,
  project: Project,
  permission: Permission,
  opts: { notice?: boolean; appName?: string } = {}
): Promise<AppAccess> {
  // Orphans have their own adopt path in every caller; nothing here applies.
  if (!project.companyId) return { ok: false, refusal: null };

  if (actor.kind === "workspace") {
    if (project.companyId === actor.companyId) return { ok: true, notice: null };
    if (await wasMovedOutOf(project.id, actor.companyId)) {
      return { ok: false, refusal: appMoved(actor, opts.appName) };
    }
    return { ok: false, refusal: null };
  }

  if (actor.userId) {
    const access = await resolveAccess(actor.userId, project.companyId);
    if (access && accessAllows(access, permission, project)) {
      return { ok: true, notice: opts.notice ? await movedNotice(actor, project) : null };
    }
    // Still a member and can see the app, but their role doesn't allow
    // this: say so, with the role, as the dashboard does — not no_access,
    // which means they're no longer in the workspace.
    if (access && accessAllows(access, "app.view", project)) {
      return {
        ok: false,
        refusal: { status: 403, code: "permission_denied", reason: permissionDeniedBody(permission, access, project).error },
      };
    }
  }
  // A person who knows the app's current workspace (was in it, or still is
  // without this permission) is told exactly that; only someone who never
  // was gets the vaguer "it moved somewhere you aren't".
  if (await knowsWorkspace(actor, project.companyId)) {
    return { ok: false, refusal: await noAccess(project.companyId, permission) };
  }
  if (await movedAwayFromReach(actor, project)) {
    return { ok: false, refusal: appMoved(actor, opts.appName) };
  }
  return { ok: false, refusal: null };
}

/**
 * May this caller create a new app (or adopt an orphan) in its own/default
 * workspace? Null when it may. A workspace-kind caller always may — that
 * was never checked and still isn't. A user token whose person has left its
 * default workspace is refused here, so a revoked membership can never
 * produce a fresh app instead of an error.
 */
export async function createRefusal(actor: AccessActor): Promise<AccessRefusal | null> {
  if (actor.kind === "workspace") return null;
  if (actor.userId && (await can(actor.userId, actor.companyId, "app.create"))) return null;
  return noAccess(actor.companyId, "app.create");
}
