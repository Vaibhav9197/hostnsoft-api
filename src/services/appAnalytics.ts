/**
 * Proxies hostnsoft-deploy's GET /internal/apps/:appName/analytics — see
 * hostnsoft-deploy's analytics/*.js for how traffic (from Traefik's
 * access log) and CPU/memory (from Nomad's stats API) are actually
 * derived. Best-effort, same pattern as appHealth.ts: a hostnsoft-deploy
 * outage (or analytics simply being disabled there — both env vars it
 * needs are optional) must never fail the whole request, so any failure
 * returns null rather than throwing, and the caller decides how to
 * represent "not available" to its own client.
 */
import { logger } from "../lib/logger";
import { HOSTNSOFT_DEPLOY_URL, INTERNAL_API_SECRET } from "../lib/internalDeployClient";

export type AnalyticsRange = "24h" | "7d" | "30d" | "90d" | "all";

export interface AppAnalytics {
  traffic: {
    range: string;
    totalRequests: number;
    statusBreakdown: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
    latencyMs: { p50: number | null; p95: number | null };
    topPaths: { path: string; requests: number }[];
    series: { bucketStart: string; requests: number; errors: number }[];
  };
  resourceUsage: {
    range: string;
    current: { cpuPercent: number | null; memoryMb: number | null; sampledAt: string } | null;
    series: { bucketStart: string; avgCpuPercent: number | null; maxCpuPercent: number | null; avgMemoryMb: number | null; maxMemoryMb: number | null }[];
  };
}

export async function fetchAppAnalytics(slug: string, range: AnalyticsRange): Promise<AppAnalytics | null> {
  let response: Response;
  try {
    response = await fetch(`${HOSTNSOFT_DEPLOY_URL}/internal/apps/${slug}/analytics?range=${range}`, {
      headers: { "X-Internal-Secret": INTERNAL_API_SECRET },
    });
  } catch (e) {
    logger.error(`[appAnalytics] could not reach hostnsoft-deploy fetching analytics for "${slug}": ${(e as Error).message}`);
    return null;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[appAnalytics] hostnsoft-deploy returned HTTP ${response.status} fetching analytics for "${slug}": ${bodyText}`);
    return null;
  }

  return (await response.json().catch(() => null)) as AppAnalytics | null;
}
