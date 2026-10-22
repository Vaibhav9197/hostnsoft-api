/**
 * Authenticating an AI agent (or a CI script) holding a deploy token,
 * against one app addressed by name.
 *
 * The dashboard's own routes authenticate a signed-in person with
 * requireProxyToken and address resources as
 * /companies/:companyId/projects/:projectId/... An agent has neither of
 * those ids — it knows the app name it just deployed, and a deploy token.
 * That mismatch, not a missing feature, is why agents previously couldn't
 * reach env vars or rollback at all.
 *
 * Deploy tokens are company-wide (schema.prisma's DeployToken has no
 * project scope), so the authorization check that matters is "does this
 * app belong to the token's company" — exactly the check
 * middleware/projectContext.ts makes for a person, keyed on slug instead
 * of id. 404 rather than 403 when it doesn't, for the same reason as
 * there: never confirm an app's existence to a caller who doesn't own it.
 *
 * Since 2026-10-21 that is the rule for a WORKSPACE token only. A user token
 * acts as its person and reaches an app in any workspace where can() allows
 * the operation; the decision, and the two refusals a caller with a stake in
 * the app gets instead of the 404 (app_moved, no_access), live in
 * services/tokenAccess.ts. req.company then becomes the APP's workspace, so
 * the audit rows these routes write land where the app is.
 */
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import type { Project } from "@prisma/client";
import { findLiveDeployToken, tokenActorOf } from "../services/deployTokenAuth";
import { accessActorOf, checkAppAccess } from "../services/tokenAccess";
import type { Permission } from "../lib/permissions";
import { findRenamedApp } from "../services/slugChangeFlow";
import { platformAppUrl } from "../services/showcase";

export async function requireDeployToken(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;

  // A missing credential and a rejected one are the same outcome here.
  // Unlike POST /apps, there is no anonymous path for these endpoints:
  // an unclaimed app has no company, so there is nothing to authorize
  // against and nothing an agent could be permitted to change.
  if (!token) {
    return res.status(401).json({
      error: "This endpoint needs a deploy token.",
      code: "unauthorized",
    });
  }

  const record = await findLiveDeployToken(token);
  if (!record) {
    return res.status(401).json({
      error: "This deploy token is invalid, revoked, or expired.",
      code: "unauthorized",
    });
  }

  req.deployToken = record;
  req.actor = tokenActorOf(record);
  // Downstream shares middleware and audit code with the dashboard, which
  // reads req.company. An agent acts for the token's company and, for
  // anything needing a user, for whoever issued the token — the closest
  // truthful attribution available, and what makes the action traceable
  // to a person in the audit log.
  req.company = { id: record.companyId };
  req.userId = record.createdBy;
  next();
}

// What an agent route under /apps/:appName asks can() for, from its method
// and path. One table rather than a permission per route, so a new route
// gets a sensible answer by default (anything that writes = app.settings)
// and the roles branch has one place to refine.
export function agentPermission(method: string, path: string): Permission {
  const sub = path.replace(/\/+$/, "") || "/";
  if (method === "GET" || method === "HEAD") return "app.view";
  if (method === "DELETE" && sub === "/") return "app.delete";
  // Both put a new version of the app live.
  if (sub === "/rollback" || sub === "/env-vars/apply") return "app.deploy";
  return "app.settings";
}

// Puts the app on the request, as the app's workspace — or answers for it.
// Shared by both loaders below.
async function admit(
  req: Request,
  res: Response,
  next: NextFunction,
  project: Project,
  permission: Permission
): Promise<boolean> {
  const access = await checkAppAccess(accessActorOf(req.actor!), project, permission, { appName: req.params.appName });
  if (access.ok) {
    req.project = project;
    req.company = { id: project.companyId! };
    // A user token's access just went through can(), which asked proxy
    // whether its person is in this workspace — requirePermission needn't
    // ask again on the same request.
    if (req.actor!.kind === "user") req.membershipChecked = true;
    next();
    return true;
  }
  if (access.refusal) {
    res.status(access.refusal.status).json({ error: access.refusal.reason, code: access.refusal.code });
    return true;
  }
  return false;
}

// Must run after requireDeployToken, on any route with an :appName param.
// `slug` is the app name an agent already has: it's what it passed as
// X-App-Name, and it's the live subdomain.
//
// Looked up platform-wide, then checked: names are unique across every
// workspace, so the one app a name can mean is found first and the token's
// access to it decided second (services/tokenAccess.ts).
export async function loadAppBySlug(req: Request, res: Response, next: NextFunction) {
  const companyId = req.actor!.companyId;
  const appName = req.params.appName;
  const permission = agentPermission(req.method, req.path);

  const project = await prisma.project.findUnique({ where: { slug: appName } });
  if (project && !project.isOrphan && (await admit(req, res, next, project, permission))) return;

  if (!project) {
    // It may not be missing, just moved: every caller still holding the
    // old name arrives here, and "no such app" is both false and
    // unrecoverable for them. Answering with the new name is what makes
    // a rename non-terminal for agents and CI — an extra lookup on a
    // path that was going to 404 anyway.
    //
    // An old name is reserved platform-wide (SlugAlias), so it, too, is
    // looked up everywhere and then checked; findRenamedApp covers what
    // SlugAlias can't (a rename still finishing, or an older one), and only
    // within the token's own workspace.
    const alias = await prisma.slugAlias.findUnique({ where: { slug: appName }, include: { project: true } });
    let moved: { from: string; to: string } | null = null;
    if (alias && !alias.project.isOrphan) {
      const access = await checkAppAccess(accessActorOf(req.actor!), alias.project, permission, { appName });
      if (access.ok) moved = { from: appName, to: alias.project.slug };
      else if (access.refusal) {
        return res.status(access.refusal.status).json({ error: access.refusal.reason, code: access.refusal.code });
      }
    }
    if (!moved) {
      const renamed = await findRenamedApp(companyId, appName);
      if (renamed) moved = { from: renamed.from, to: renamed.to };
    }
    if (moved) {
      // Same path, new name — so a caller can retry without having to
      // understand which part of its URL was the app.
      const retryUrl = req.originalUrl.replace(
        `/apps/${encodeURIComponent(moved.from)}`,
        `/apps/${encodeURIComponent(moved.to)}`
      );
      return res.status(404).json({
        error: `The app "${moved.from}" was renamed to "${moved.to}". Use the new name.`,
        code: "app_renamed",
        newName: moved.to,
        appUrl: platformAppUrl(moved.to),
        retryUrl,
      });
    }
  }

  return res.status(404).json({
    error: `No app named "${appName}" that this token can reach.`,
    code: "app_not_found",
  });
}

// Addresses an app by its stable id instead of its name, for the one
// case where the name is the thing in motion: reading how an address
// change ended. Same access rule and same 404-not-403 rule for strangers as
// loadAppBySlug — the id is a cuid, but that is not an access control.
export async function loadAppById(req: Request, res: Response, next: NextFunction) {
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (project && !project.isOrphan && (await admit(req, res, next, project, "app.view"))) return;
  return res.status(404).json({ error: "No such app that this token can reach.", code: "app_not_found" });
}
