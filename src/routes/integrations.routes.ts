/**
 * Integrations, the dashboard side — see docs/integrations.md.
 *
 * Two levels:
 *   /companies/:companyId/integrations — the workspace switch (Owner
 *     only) and a member's request to the Owners to turn it on.
 *   /companies/:companyId/projects/:projectId/integrations — one app:
 *     whether it has an embed project, turning it on and off. The
 *     viasocket workspace behind it is provisioned on the first enable.
 *
 * The agent API offers the same operations on the same services
 * (routes/agentApps.routes.ts) — what differs is only addressing and
 * authentication, as everywhere else here.
 *
 * Nothing in any reply names viasocket, and no reply ever carries the
 * partner key, a workspace's auth key, or a viasocket session.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { loadProjectContext } from "../middleware/projectContext";
import { requirePermission } from "../middleware/requirePermission";
import { refuseForStaticApp } from "../middleware/refuseForStaticApp";
import { integrationsConfigured } from "../lib/integrationsConfig";
import { getUserById } from "../lib/msg91";
import { requestWorkspaceIntegrations } from "../services/integrationsRequest";
import { consoleLinkFor } from "../services/integrationsWorkspace";
import { z } from "zod";
import { accessFor } from "../middleware/requirePermission";
import {
  CredentialError,
  disableIntegrations,
  enableIntegrations,
  integrationsStatus,
  setWorkspaceIntegrations,
  workspaceIntegrationsEnabled,
  WORKSPACE_DISABLED_MESSAGE,
} from "../services/integrationsProject";
import { prisma } from "../lib/prisma";

export const integrationsRouter = Router();
integrationsRouter.use(requireProxyToken);

// An environment that was never onboarded answers one clear thing on
// every Integrations route, rather than failing deeper with a confusing
// message about a missing key.
export function requireIntegrationsConfigured(_req: Request, res: Response, next: NextFunction) {
  if (!integrationsConfigured()) {
    return res.status(503).json({
      error: "Integrations isn't available on this environment yet.",
      code: "integrations_not_configured",
    });
  }
  next();
}

// Turns the service's typed errors into the repo's standard {error, code}
// shape so each route stays about addressing.
export function sendFeatureError(res: Response, err: unknown): boolean {
  if (err instanceof CredentialError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

// ------------------------------------------------------------ workspace

export const OWNER_ONLY_MESSAGE = "Only company owners can enable or disable this feature.";

// Any member may read it: an app's page needs to say why Turn on is
// refused. canChange tells the dashboard whether to offer the switch.
integrationsRouter.get(
  "/companies/:companyId/integrations",
  loadCompanyContext,
  requireIntegrationsConfigured,
  async (req, res) => {
    const access = await accessFor(req);
    res.json({
      enabled: await workspaceIntegrationsEnabled(req.company!.id),
      canChange: access?.role === "owner",
    });
  }
);

// Owner only. Not a permission in permissions.ts: there is exactly one
// such switch, and "Owner" is the whole rule.
integrationsRouter.put(
  "/companies/:companyId/integrations",
  loadCompanyContext,
  requireIntegrationsConfigured,
  async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const access = await accessFor(req);
    if (access?.role !== "owner") {
      return res.status(403).json({ error: OWNER_ONLY_MESSAGE, code: "owner_required" });
    }
    await setWorkspaceIntegrations(req.company!.id, enabled, req.userId!);
    res.json({ enabled, canChange: true });
  }
);

// A member who is not an Owner asks the Owners to turn it on. Optional
// projectId names the app they wanted it for. Any member; one email per
// app (or per workspace) per day.
integrationsRouter.post(
  "/companies/:companyId/integrations/request",
  loadCompanyContext,
  requireIntegrationsConfigured,
  async (req, res) => {
    const { projectId } = z.object({ projectId: z.string().optional() }).parse(req.body ?? {});
    const companyId = req.company!.id;
    if (await workspaceIntegrationsEnabled(companyId)) {
      return res.status(409).json({ error: "Integrations is already on for this workspace.", code: "integrations_already_enabled" });
    }
    const project = projectId
      ? await prisma.project.findFirst({ where: { id: projectId, companyId }, select: { id: true, slug: true, name: true } })
      : null;
    const email = req.proxyIdentity?.email ?? (await getUserById(req.userId!))?.email ?? null;
    const notified = await requestWorkspaceIntegrations(companyId, project, req.userId!, email ?? "A workspace member");
    res.json({ ownersNotified: notified > 0 });
  }
);

// One click into viasocket's workspace page, signed in as this member.
// The link is a credential that expires in hours, so: no-referrer,
// no-store, and ?format=json for a panel that opens it in a new tab.
async function sendConsoleLink(req: Request, res: Response, embedProjectId?: string) {
  const companyId = req.company!.id;
  if (!(await workspaceIntegrationsEnabled(companyId))) {
    return res.status(409).json({ error: WORKSPACE_DISABLED_MESSAGE, code: "integrations_disabled_for_workspace" });
  }
  const email = req.proxyIdentity?.email ?? (await getUserById(req.userId!))?.email ?? null;
  if (!email) {
    return res.status(409).json({ error: "Add an email address to your account before opening Integrations.", code: "email_required" });
  }
  const url = await consoleLinkFor(companyId, req.userId!, email, embedProjectId);
  res.set("Referrer-Policy", "no-referrer");
  res.set("Cache-Control", "no-store");
  if (req.query.format === "json") return res.json({ url });
  res.redirect(302, url);
}

integrationsRouter.get(
  "/companies/:companyId/integrations/console",
  loadCompanyContext,
  requireIntegrationsConfigured,
  async (req, res) => sendConsoleLink(req, res)
);

// ------------------------------------------------------------- per app

// app.view, not app.settings: once a workspace Owner has turned the
// switch on, every member may use Integrations on any app they can see.
// It does write the app's env vars, but only the three fixed ones.
integrationsRouter.get(
  "/companies/:companyId/projects/:projectId/integrations",
  loadCompanyContext,
  loadProjectContext,
  requireIntegrationsConfigured,
  requirePermission("app.view"),
  async (req, res) => {
    res.json(await integrationsStatus(req.project!.id));
  }
);

integrationsRouter.post(
  "/companies/:companyId/projects/:projectId/integrations",
  loadCompanyContext,
  loadProjectContext,
  requireIntegrationsConfigured,
  refuseForStaticApp("integrations"),
  requirePermission("app.view"),
  async (req, res) => {
    const email = req.proxyIdentity?.email ?? (await getUserById(req.userId!))?.email ?? null;
    try {
      const result = await enableIntegrations(req.project!, req.userId!, email);
      res.status(result.alreadyEnabled ? 200 : 201).json(result);
    } catch (err) {
      if (!sendFeatureError(res, err)) throw err;
    }
  }
);

// This app's embed metrics on viasocket, signed in. Needs the app on.
integrationsRouter.get(
  "/companies/:companyId/projects/:projectId/integrations/console",
  loadCompanyContext,
  loadProjectContext,
  requireIntegrationsConfigured,
  requirePermission("app.view"),
  async (req, res) => {
    const row = await prisma.integrationsProject.findUnique({ where: { projectId: req.project!.id } });
    if (!row || row.disabledAt) {
      return res.status(409).json({ error: "Integrations isn't on for this app yet.", code: "integrations_not_enabled" });
    }
    return sendConsoleLink(req, res, row.embedProjectId);
  }
);

integrationsRouter.delete(
  "/companies/:companyId/projects/:projectId/integrations",
  loadCompanyContext,
  loadProjectContext,
  requireIntegrationsConfigured,
  requirePermission("app.view"),
  async (req, res) => {
    await disableIntegrations(req.project!, req.userId!);
    res.status(204).end();
  }
);
