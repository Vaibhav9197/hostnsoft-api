/**
 * One app's embed project on viasocket — see docs/integrations.md.
 *
 * Turning Integrations on for an app creates (or finds) an embed project
 * titled "Embarko-<projectId>" in the workspace's viasocket workspace and
 * writes three env vars the app reads to mint embed tokens and load the
 * embed itself: the org id, the project id, and the workspace's auth key.
 * Written here, baked into the job spec by hostnsoft-deploy on the next
 * deploy, same as CRON_SECRET (services/scheduleSync.ts).
 *
 * Turning Integrations off removes the env vars and flags the row
 * (disabledAt); the row and the viasocket project both stay, so Embarko
 * keeps its record of which project is whose and the person's flows are
 * kept. Turning it on again clears the flag and rewrites the env vars from
 * the stored ids, with no call to viasocket.
 */
import { prisma } from "../lib/prisma";
import type { IntegrationsProject, Project } from "@prisma/client";
import { createEmbedProject, listEmbedProjects } from "../lib/viasocket";
import { ensureIntegrationsWorkspace, sessionFor } from "./integrationsWorkspace";
import { logAudit } from "./audit";
import { logger } from "../lib/logger";

// Named for what they are to the app, not for what runs behind them: the
// person knows "Integrations", not the engine. viaSocket's SDK reads
// VIASOCKET_* names, so the skill and the agent reply spell the mapping.
export const INTEGRATIONS_ORG_ID_KEY = "INTEGRATIONS_ORG_ID";
export const INTEGRATIONS_PROJECT_ID_KEY = "INTEGRATIONS_PROJECT_ID";
export const INTEGRATIONS_SECRET_KEY = "INTEGRATIONS_SECRET";
const ENV_KEYS = [INTEGRATIONS_ORG_ID_KEY, INTEGRATIONS_PROJECT_ID_KEY, INTEGRATIONS_SECRET_KEY] as const;

export function embedProjectTitleFor(projectId: string): string {
  return `Embarko-${projectId}`;
}

export class CredentialError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface IntegrationsStatus {
  enabled: boolean;
  // Named so a client can show them without hardcoding the set.
  envVars: string[];
  // What has to happen before the running app can see a change.
  appliesWhen: string;
}

function statusOf(row: IntegrationsProject | null): IntegrationsStatus {
  return { enabled: !!row && !row.disabledAt, envVars: [...ENV_KEYS], appliesWhen: "next deploy or apply" };
}

function envRows(projectId: string, row: IntegrationsProject, orgId: string, actorUserId: string) {
  const vars = {
    [INTEGRATIONS_ORG_ID_KEY]: orgId,
    [INTEGRATIONS_PROJECT_ID_KEY]: row.embedProjectId,
    [INTEGRATIONS_SECRET_KEY]: row.authKey,
  };
  return Object.entries(vars).map(([key, value]) => ({ projectId, key, value, createdBy: actorUserId, updatedBy: actorUserId }));
}

// ------------------------------------------------- workspace switch

// Whether Integrations is allowed in this workspace at all. Off until an
// Owner turns it on; until then no app here can enable it.
export async function workspaceIntegrationsEnabled(companyId: string): Promise<boolean> {
  const row = await prisma.company.findUnique({ where: { id: companyId }, select: { integrationsEnabled: true } });
  return row?.integrationsEnabled ?? false;
}

// Turning the switch off also turns Integrations off for every app in the
// workspace: an Owner who turns it off means "no app here uses this", not
// "no new app may start". Each app's env vars go on its next deploy.
export async function setWorkspaceIntegrations(companyId: string, enabled: boolean, actorUserId: string): Promise<void> {
  await prisma.company.upsert({
    where: { id: companyId },
    create: { id: companyId, integrationsEnabled: enabled },
    update: { integrationsEnabled: enabled },
  });
  await logAudit({ actorUserId, companyId, action: enabled ? "integrations.workspace.enable" : "integrations.workspace.disable" });
  if (enabled) return;
  const apps = await prisma.integrationsProject.findMany({ where: { companyId, disabledAt: null }, select: { projectId: true } });
  for (const { projectId } of apps) {
    await disableIntegrations({ id: projectId, companyId }, actorUserId, "workspace switch off");
  }
}

export const WORKSPACE_DISABLED_MESSAGE =
  "Integrations is off for this workspace. Only a workspace Owner can turn it on, under Settings.";

export async function integrationsStatus(projectId: string): Promise<IntegrationsStatus> {
  return statusOf(await prisma.integrationsProject.findUnique({ where: { projectId } }));
}

export interface EnableResult {
  status: IntegrationsStatus;
  alreadyEnabled: boolean;
}

export async function enableIntegrations(
  project: Pick<Project, "id" | "companyId" | "slug">,
  actorUserId: string,
  email: string | null = null
): Promise<EnableResult> {
  if (!project.companyId) {
    throw new CredentialError(
      409,
      "app_not_claimed",
      "This app isn't in a workspace yet. Claim it with a deploy token first, then turn Integrations on."
    );
  }

  const existing = await prisma.integrationsProject.findUnique({ where: { projectId: project.id } });
  // A row from another workspace (the app moved) is stale: its project
  // and key belong to the workspace it left, so it is replaced below.
  const stale = !!existing && existing.companyId !== project.companyId;
  if (existing && !stale && !existing.disabledAt) return { status: statusOf(existing), alreadyEnabled: true };

  if (!(await workspaceIntegrationsEnabled(project.companyId))) {
    throw new CredentialError(409, "integrations_disabled_for_workspace", WORKSPACE_DISABLED_MESSAGE);
  }

  // Never overwrite a value the owner set.
  const clashes = await prisma.envVar.findMany({
    where: { projectId: project.id, key: { in: [...ENV_KEYS] } },
    select: { key: true },
  });
  if (clashes.length > 0) {
    throw new CredentialError(
      409,
      "env_var_conflict",
      `This app already sets ${clashes.map((c) => c.key).join(", ")} itself. Remove ${
        clashes.length > 1 ? "those settings" : "that setting"
      } first, or leave Integrations off.`
    );
  }

  // Turned off earlier in this same workspace: the project and its key are
  // already known, so this is a flag flip and the env vars back, with no
  // call to viasocket.
  if (existing && !stale) {
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.integrationsProject.update({ where: { projectId: project.id }, data: { disabledAt: null } });
      const workspace = await tx.integrationsWorkspace.findUniqueOrThrow({ where: { companyId: project.companyId! } });
      await tx.envVar.createMany({ data: envRows(project.id, updated, workspace.orgId, actorUserId) });
      return updated;
    });
    await logAudit({ actorUserId, companyId: project.companyId, projectId: project.id, action: "integrations.enable", details: `${row.embedProjectId} (again)` });
    return { status: statusOf(row), alreadyEnabled: false };
  }

  // Everything on viasocket's side happens before anything is written
  // here, so a failure leaves nothing half-done.
  const workspace = await ensureIntegrationsWorkspace(project.companyId, actorUserId, email);
  const session = await sessionFor(workspace);
  const title = embedProjectTitleFor(project.id);
  const found = (await listEmbedProjects(workspace.orgId, session)).find((p) => p.title === title);
  const embed = found ?? (await createEmbedProject(workspace.orgId, session, title));

  // The project's own key. viasocket issues one per workspace today, so
  // it is the workspace key; when viasocket hands out one per project,
  // fetch it here instead and nothing downstream changes.
  const authKey = workspace.authKey;
  const row = await prisma.$transaction(async (tx) => {
    // upsert: a stale row from a previous workspace is overwritten.
    const data = { companyId: project.companyId!, embedProjectId: embed.id, authKey, createdBy: actorUserId, disabledAt: null };
    const created = await tx.integrationsProject.upsert({
      where: { projectId: project.id },
      create: { projectId: project.id, ...data },
      update: data,
    });
    await tx.envVar.createMany({ data: envRows(project.id, created, workspace.orgId, actorUserId) });
    return created;
  });

  await logAudit({
    actorUserId,
    companyId: project.companyId,
    projectId: project.id,
    action: "integrations.enable",
    details: embed.id,
  });
  return { status: statusOf(row), alreadyEnabled: false };
}

// Flags the row and removes the app's env vars. The row and the embed
// project on viasocket both stay (the flows are the customer's work, and
// the row is how Embarko knows which project is this app's).
export async function disableIntegrations(
  project: Pick<Project, "id" | "companyId">,
  actorUserId: string,
  reason?: string
): Promise<{ wasEnabled: boolean }> {
  const existing = await prisma.integrationsProject.findUnique({ where: { projectId: project.id } });
  const wasEnabled = !!existing && !existing.disabledAt;

  // The env vars are deleted even with no live mapping: a half state would
  // leave the app loading an embed nobody is tracking.
  await prisma.$transaction([
    ...(wasEnabled ? [prisma.integrationsProject.update({ where: { projectId: project.id }, data: { disabledAt: new Date() } })] : []),
    prisma.envVar.deleteMany({ where: { projectId: project.id, key: { in: [...ENV_KEYS] } } }),
  ]);

  if (wasEnabled && existing) {
    await logAudit({
      actorUserId,
      companyId: project.companyId ?? undefined,
      projectId: project.id,
      action: "integrations.disable",
      details: reason ? `${existing.embedProjectId} (${reason})` : existing.embedProjectId,
    });
  }
  return { wasEnabled };
}

// Called when an app changes workspace. The embed project belongs to the
// viasocket workspace it is leaving, so the app is turned off here and
// the owner turns it on again where it now lives.
export async function revokeForWorkspaceMove(projectId: string, actorUserId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, companyId: true } });
  if (!project) return;
  try {
    await disableIntegrations(project, actorUserId, "moved");
  } catch (err) {
    logger.error(`[integrations] could not turn off Integrations on move for ${projectId}: ${(err as Error).message}`);
  }
}
