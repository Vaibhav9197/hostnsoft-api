/**
 * Runtime facts for the admin panel's Customer apps and Platform health
 * pages: one call to hostnsoft-deploy's GET /internal/admin/overview, which
 * reads Nomad in bulk, the analytics samples, the activator's wake failures
 * and the platform monitor's status file (Server-setup
 * server-setup.md#platform-status).
 *
 * Cached for a few seconds: both pages poll, and two admins looking at the
 * same time need not make deploy-service read Nomad twice.
 */
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";
import { logger } from "../lib/logger";

export interface AppRuntime {
  health: "running" | "starting" | "crashed" | "stopped" | "asleep" | "unknown";
  asleepSince: string | null;
  /** Restarts the app caused itself (it exited on its own). */
  crashes24h: number;
  lastCrashAt: string | null;
  /** Restarts the platform caused: Docker restarted, or many apps at once. */
  platformRestarts24h: number;
  oomTerminations24h: number;
  oomKills24h: number;
  lastOom: { at: string; task?: string; process?: string; mb?: number | null } | null;
  memoryLimitMb: number | null;
  memoryMb?: number;
  memoryPeak24hMb?: number;
  cpuPercent?: number;
  sampledAt?: string;
  wakeFailures24h: number;
  lastWakeFailure: { at: string; reason: string; ms: number } | null;
}

export interface AdminOverview {
  generatedAt: string;
  // The monitor's status file, as written (see the Server-setup doc above).
  monitor: Record<string, unknown> | null;
  monitorStale: boolean;
  monitorError: string | null;
  samplesError: string | null;
  apps: Record<string, AppRuntime>;
}

const CACHE_MS = 10_000;
// Under the 15 s the admin Health monitor (hostnsoft app/lib/monitor/tick.ts)
// allows /admin/apps, so a slow deploy-service never times that out.
const TIMEOUT_MS = 6_000;
let cached: { at: number; value: AdminOverview } | null = null;

/** The overview, or null with the reason when deploy-service can't give one. */
export async function fetchAdminOverview(): Promise<{ overview: AdminOverview | null; error: string | null }> {
  if (cached && Date.now() - cached.at < CACHE_MS) return { overview: cached.value, error: null };
  try {
    const res = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/admin/overview`, {
      headers: { "X-Internal-Secret": INTERNAL_API_SECRET },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { overview: null, error: body.error ?? `deploy-service answered ${res.status}` };
    }
    const value = (await res.json()) as AdminOverview;
    cached = { at: Date.now(), value };
    return { overview: value, error: null };
  } catch (e) {
    logger.warn(`[adminOverview] ${(e as Error).message}`);
    return { overview: null, error: `Could not reach deploy-service: ${(e as Error).message}` };
  }
}

export type ProblemCause = "our-limit" | "platform" | "app";
export interface AppProblem {
  kind: "oom" | "memory-high" | "wake-failed" | "restarting" | "platform-restarts" | "crashed" | "deploy-failed";
  cause: ProblemCause;
  /** "note": worth seeing on the app, but nothing to do for it (a server
   * restart touched every app). Not counted as needing attention. */
  severity: "attention" | "note";
  text: string;
}

const MEMORY_HIGH_PCT = 90;

/**
 * What is wrong with an app right now, and whose side it is on. "our-limit"
 * means a limit the platform sets (memory); "platform" means our machinery
 * (waking); "app" means the app's own code or deploy.
 */
export function problemsFor(rt: AppRuntime | undefined, latestDeployStatus: string): AppProblem[] {
  const out: AppProblem[] = [];
  if (latestDeployStatus === "failed") out.push({ kind: "deploy-failed", cause: "app", severity: "attention", text: "Its last deploy failed" });
  if (!rt) return out;
  const limit = rt.memoryLimitMb;
  if (rt.oomKills24h > 0) {
    out.push({
      kind: "oom",
      cause: "our-limit",
      severity: "attention",
      text: `Ran out of memory ${rt.oomKills24h}× in 24 h${limit ? ` at its ${limit} MB limit` : ""}`,
    });
  } else if (rt.oomTerminations24h > 0) {
    out.push({ kind: "oom", cause: "our-limit", severity: "attention", text: `Ran out of memory ${rt.oomTerminations24h}× in 24 h${limit ? ` at its ${limit} MB limit` : ""}` });
  }
  if (limit && rt.memoryMb !== undefined && (rt.memoryMb / limit) * 100 >= MEMORY_HIGH_PCT) {
    out.push({ kind: "memory-high", cause: "our-limit", severity: "attention", text: `Using ${Math.round((rt.memoryMb / limit) * 100)}% of its ${limit} MB memory limit` });
  }
  if (rt.wakeFailures24h > 0) {
    const reason = rt.lastWakeFailure?.reason ?? "";
    // An app that crashes on start is the app's to fix; one that was still
    // starting when our 90 s wake timeout ran out is ours to look at.
    const cause: ProblemCause = reason.startsWith("crashed") ? "app" : "platform";
    out.push({ kind: "wake-failed", cause, severity: "attention", text: `Failed to wake ${rt.wakeFailures24h}× in 24 h (${reason || "unknown reason"})` });
  }
  if (rt.crashes24h > 0) out.push({ kind: "restarting", cause: "app", severity: "attention", text: `Crashed and restarted ${rt.crashes24h}× in 24 h` });
  if (rt.platformRestarts24h > 0) {
    out.push({
      kind: "platform-restarts",
      cause: "platform",
      severity: "note",
      text: `Restarted ${rt.platformRestarts24h}× in 24 h by a server or Docker restart`,
    });
  }
  if (rt.health === "crashed") out.push({ kind: "crashed", cause: "app", severity: "attention", text: "Crashed and not running" });
  return out;
}

/** Something on this app needs a person (notes don't count). */
export function needsAttention(problems: AppProblem[]): boolean {
  return problems.some((p) => p.severity === "attention");
}
