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
 */
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { findLiveDeployToken } from "../services/deployTokenAuth";
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
  // Downstream shares middleware and audit code with the dashboard, which
  // reads req.company. An agent acts for the token's company and, for
  // anything needing a user, for whoever issued the token — the closest
  // truthful attribution available, and what makes the action traceable
  // to a person in the audit log.
  req.company = { id: record.companyId };
  req.userId = record.createdBy;
  next();
}

// Must run after requireDeployToken, on any route with an :appName param.
// `slug` is the app name an agent already has: it's what it passed as
// X-App-Name, and it's the live subdomain.
export async function loadAppBySlug(req: Request, res: Response, next: NextFunction) {
  const companyId = req.deployToken!.companyId;
  const project = await prisma.project.findFirst({
    where: { slug: req.params.appName, companyId },
  });

  if (!project) {
    // It may not be missing, just moved: every caller still holding the
    // old name arrives here, and "no such app" is both false and
    // unrecoverable for them. Answering with the new name is what makes
    // a rename non-terminal for agents and CI — an extra lookup on a
    // path that was going to 404 anyway.
    const moved = await findRenamedApp(companyId, req.params.appName);
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

    return res.status(404).json({
      error: `No app named "${req.params.appName}" in this workspace.`,
      code: "app_not_found",
    });
  }

  req.project = project;
  next();
}

// Addresses an app by its stable id instead of its name, for the one
// case where the name is the thing in motion: reading how an address
// change ended. Same company check and same 404-not-403 rule as
// loadAppBySlug — the id is a cuid, but that is not an access control.
export async function loadAppById(req: Request, res: Response, next: NextFunction) {
  const project = await prisma.project.findFirst({
    where: { id: req.params.projectId, companyId: req.deployToken!.companyId },
  });

  if (!project) {
    return res.status(404).json({ error: "No such app in this workspace.", code: "app_not_found" });
  }

  req.project = project;
  next();
}
