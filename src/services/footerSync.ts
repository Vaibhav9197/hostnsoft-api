/**
 * Keeps the "hosted on Embarko" footer on every app in line with the
 * company's plan: shown on free, gone on any paid plan.
 *
 * Runs on an upgrade (billing.routes.ts, straight away) and on a timer
 * (startFooterSyncLoop), which catches what no route of ours sees — a
 * downgrade or cancel taking effect at period end in Lago, a failed
 * payment, a plan changed in the Lago console.
 *
 * Per app it asks hostnsoft-deploy to flip the footer flag
 * (POST /internal/apps/:slug/footer), which takes effect in seconds with
 * no restart. When the flag can't do it alone (a static app, an app with
 * no footer sidecar to switch on, or one deployed before the flag existed)
 * hostnsoft-deploy says config_push_required, and the app's current config
 * is pushed again with the plan — no new deployment row, but a container
 * app restarts once. See hostnsoft-deploy's docs/Footer-flag-req.md.
 *
 * If Lago can't be asked, nothing changes: an outage must never strip or
 * add footers across the board.
 */
import type { Project } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";
import { FOOTER_SYNC_INTERVAL_MS, FOOTER_SYNC_PUSH_GAP_MS, FOOTER_SYNC_REFRESH_MS } from "../lib/footerSyncConfig";
import { isCompanyOnFreePlan } from "./companyPlan";
import { pushCustomDomainConfig } from "./customDomainActivation";
import { isRenameInProgress } from "./renameStatus";
import { logAudit } from "./audit";

// The plan last fully applied to each company's apps, so the timer only
// touches companies whose plan changed (or whose entry is older than
// FOOTER_SYNC_REFRESH_MS). In memory on purpose: after a restart it is
// empty and the first run re-applies every company once, which is
// harmless — a flag write per app, a push only where one is needed.
const applied = new Map<string, { isFree: boolean; at: number }>();

// One sync per company at a time, in order, so an upgrade landing while
// the timer is mid-way through the same company can't interleave with it.
const inFlight = new Map<string, Promise<void>>();

type SwitchOutcome = "applied" | "config_push_required" | "not_found" | "failed";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function switchFooter(project: Project, show: boolean): Promise<SwitchOutcome> {
  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${project.slug}/footer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": INTERNAL_API_SECRET },
      body: JSON.stringify({ show }),
    });
  } catch (e) {
    logger.error(`[footerSync] could not reach hostnsoft-deploy for ${project.slug}: ${(e as Error).message}`);
    return "failed";
  }
  if (response.ok) return "applied";

  const body = (await response.json().catch(() => null)) as { code?: string } | null;
  if (response.status === 409 && body?.code === "config_push_required") return "config_push_required";
  // Only hostnsoft-deploy's own "no such app" counts as nothing to do. A
  // bare 404 is a deploy service without this endpoint yet — retry later.
  if (response.status === 404 && body?.code === "app_not_found") return "not_found";
  logger.error(`[footerSync] hostnsoft-deploy returned HTTP ${response.status} for ${project.slug}: ${JSON.stringify(body)}`);
  return "failed";
}

async function runSync(companyId: string, knownIsFree?: boolean): Promise<void> {
  const isFree = knownIsFree ?? (await isCompanyOnFreePlan(companyId));
  if (isFree === null) return;

  const projects = await prisma.project.findMany({
    where: { companyId, isOrphan: false, currentDeploymentId: { not: null } },
  });

  let complete = true;
  for (const project of projects) {
    // A rename rebuilds the app itself, with the plan (appRename.ts).
    if (isRenameInProgress(project.id)) {
      complete = false;
      continue;
    }

    const outcome = await switchFooter(project, isFree);
    if (outcome === "failed") complete = false;
    if (outcome !== "config_push_required") continue;

    const result = await pushCustomDomainConfig(project.id, isFree);
    if (!result.pushed) {
      complete = false;
      continue;
    }
    await logAudit({
      companyId,
      projectId: project.id,
      action: "project.footer.push",
      details: isFree ? "footer on (free plan)" : "footer off (paid plan)",
    });
    await sleep(FOOTER_SYNC_PUSH_GAP_MS);
  }

  // Anything left undone is retried on the next timer run.
  if (complete) applied.set(companyId, { isFree, at: Date.now() });
  else applied.delete(companyId);
  logger.info(`[footerSync] ${companyId}: footer ${isFree ? "on" : "off"} for ${projects.length} app(s)${complete ? "" : ", some to retry"}`);
}

/**
 * Bring every app of one company in line with its plan. `knownIsFree`
 * skips the Lago lookup when the caller has just set the plan itself.
 */
export function syncFooterForCompany(companyId: string, knownIsFree?: boolean): Promise<void> {
  const previous = inFlight.get(companyId) ?? Promise.resolve();
  const next = previous.catch(() => { }).then(() => runSync(companyId, knownIsFree));
  inFlight.set(companyId, next);
  next
    .finally(() => {
      if (inFlight.get(companyId) === next) inFlight.delete(companyId);
    })
    .catch(() => { });
  return next;
}

async function syncAllCompanies(): Promise<void> {
  const rows = await prisma.project.findMany({
    where: { isOrphan: false, companyId: { not: null }, currentDeploymentId: { not: null } },
    select: { companyId: true },
    distinct: ["companyId"],
  });

  for (const { companyId } of rows) {
    if (!companyId) continue;
    const isFree = await isCompanyOnFreePlan(companyId);
    if (isFree === null) continue;
    const last = applied.get(companyId);
    if (last && last.isFree === isFree && Date.now() - last.at < FOOTER_SYNC_REFRESH_MS) continue;
    await syncFooterForCompany(companyId, isFree).catch((e) => {
      logger.error(`[footerSync] ${companyId} failed: ${(e as Error).message}`);
    });
  }
}

export function startFooterSyncLoop(): void {
  setInterval(() => {
    syncAllCompanies().catch((e) => {
      logger.error(`[footerSync] loop iteration failed: ${(e as Error).message}`);
    });
  }, FOOTER_SYNC_INTERVAL_MS);
}
