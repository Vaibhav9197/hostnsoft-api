/**
 * The one role check, for every route that acts inside a workspace — the
 * dashboard's (after loadCompanyContext, and loadProjectContext where the
 * route has a :projectId) and the agent API's (after requireDeployToken +
 * loadAppBySlug). See lib/permissions.ts for what each role may do, and
 * docs/CLAUDE.md for the route → permission table.
 *
 * Two refusals, on purpose:
 *
 *   - an app the caller can't even see answers 404, the same as an app
 *     that doesn't exist — the existing rule (projectContext.ts) that a
 *     resource's existence is never confirmed to someone with no access
 *     to it, now applied inside a workspace as well as across them;
 *   - anything else they're not allowed answers 403 `permission_denied`
 *     with `{permission, role}`, because there the person already knows
 *     the thing exists and needs to hear why the action failed and who can
 *     change that.
 */
import type { Request, Response, NextFunction } from "express";
import {
  DEFAULT_ROLE,
  accessAllows,
  isAppPermission,
  permissionDeniedBody,
  resolveAccess,
  type Access,
  type Permission,
} from "../lib/permissions";

// A workspace token acts as the workspace itself, not as whoever made it
// (services/tokenAccess.ts; loadAppBySlug already kept it to its own
// workspace's apps). So it is not narrowed by its maker's role and keeps
// working after they leave — the property CI needs. That is also why only
// an Owner or Admin may make one (tokens.routes.ts). Tokens that name
// nobody (createdBy "system:public-token-api", see services/emailToken.ts)
// get the same, whatever their kind.
function workspaceTokenAccess(companyId: string, createdBy: string): Access {
  return {
    companyId,
    userId: createdBy,
    role: DEFAULT_ROLE,
    explicit: false,
    appScope: "all",
    canCreate: true,
    canDelete: true,
    grants: new Map(),
  };
}

// The caller's access in req.company, worked out once per request.
export async function accessFor(req: Request): Promise<Access | null> {
  if (req.access !== undefined) return req.access;
  const companyId = req.company?.id;
  const userId = req.userId;
  if (!companyId || !userId) {
    req.access = null;
    return null;
  }

  if (req.deployToken && (req.actor?.kind !== "user" || req.deployToken.createdBy.startsWith("system:"))) {
    req.access = workspaceTokenAccess(companyId, req.deployToken.createdBy);
    return req.access;
  }

  // A user token acts as its person, with their role in the APP's workspace
  // (loadAppBySlug set req.company to it) — so it can never do more than they
  // can there, and stops when they leave (membership is re-checked:
  // requireDeployToken never asked proxy).
  req.access = await resolveAccess(req.actor?.userId ?? userId, companyId, {
    membershipChecked: req.membershipChecked === true,
    email: req.deployToken ? null : req.proxyIdentity?.email ?? null,
  });
  return req.access;
}

function notFound(req: Request, res: Response) {
  if (req.deployToken) {
    return res.status(404).json({
      error: `No app named "${req.params.appName ?? req.project?.slug}" in this workspace.`,
      code: "app_not_found",
    });
  }
  return res.status(404).json({ error: "Project not found" });
}

// The same decision for a route that only learns which app it's about from
// the body or a lookup (showcase submissions, listings), not from
// :projectId. Sends the refusal itself and answers false, so the caller
// just returns.
export async function checkAppPermission(
  req: Request,
  res: Response,
  project: { id: string; createdBy: string | null; slug?: string },
  permission: Permission
): Promise<boolean> {
  const access = await accessFor(req);
  if (!access) {
    res.status(404).json({ error: "Workspace not found" });
    return false;
  }
  if (!accessAllows(access, "app.view", project)) {
    res.status(404).json({ error: "Project not found" });
    return false;
  }
  if (!accessAllows(access, permission, project)) {
    res.status(403).json(permissionDeniedBody(permission, access));
    return false;
  }
  return true;
}

export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const access = await accessFor(req);
    if (!access) {
      // Dashboard: loadCompanyContext let them in a moment ago, so this is
      // a removal in between — same answer it would give now. Agent: the
      // token's creator is no longer in the workspace.
      if (req.deployToken) {
        return res.status(403).json({
          error:
            "The person this deploy token belongs to is no longer a member of this app's workspace, so the token can't act there. Ask someone who manages that workspace to add them back, or use a token from that workspace.",
          code: "no_access",
        });
      }
      return res.status(404).json({ error: "Workspace not found" });
    }

    const project = req.project ?? undefined;
    if (project && isAppPermission(permission) && !accessAllows(access, "app.view", project)) {
      return notFound(req, res);
    }
    if (!accessAllows(access, permission, project)) {
      return res.status(403).json(permissionDeniedBody(permission, access));
    }
    next();
  };
}
