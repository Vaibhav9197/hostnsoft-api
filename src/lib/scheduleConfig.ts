/**
 * Config for schedules — see docs/schedules.md. All optional with
 * defaults, same convention as src/lib/orphanConfig.ts. The limits are the
 * same on every plan for now; per-plan limits wait on pricing.
 */
import { envNumber } from "./env";
import { ORIGIN_SERVER_IP } from "./customDomainConfig";

// Most schedules one app may have.
export const SCHEDULE_MAX_PER_APP: number = envNumber("SCHEDULE_MAX_PER_APP", 5);

// Shortest gap allowed between two runs of one schedule. Anything more
// frequent than every few hours keeps the app awake permanently anyway
// (each call counts as real traffic), so this bounds load, not cost.
export const SCHEDULE_MIN_INTERVAL_MS: number = envNumber("SCHEDULE_MIN_INTERVAL_MS", 5 * 60 * 1000);

// How long one call may take, wake-up included, before it counts as failed.
export const SCHEDULE_RUN_TIMEOUT_MS: number = envNumber("SCHEDULE_RUN_TIMEOUT_MS", 5 * 60 * 1000);

// How often the runner looks for due schedules. Runs fire within this much
// of their due time.
export const SCHEDULE_TICK_MS: number = envNumber("SCHEDULE_TICK_MS", 30 * 1000);

// Most calls in flight at once across all apps, so a busy "0 * * * *"
// can't open hundreds of connections in the same second. Due runs beyond
// this wait for the next tick.
export const SCHEDULE_MAX_CONCURRENT_RUNS: number = envNumber("SCHEDULE_MAX_CONCURRENT_RUNS", 20);

// Failed runs in a row before the owner is emailed and the app shows
// "Needs attention". One failure is usually a blip (a dropped connection,
// a restart) that the next run gets past; this waits for a pattern.
export const SCHEDULE_ALERT_AFTER_FAILURES: number = Math.max(1, envNumber("SCHEDULE_ALERT_AFTER_FAILURES", 3));

// ...or once a failure streak is this old with no success, whichever comes
// first, so a daily job is not left broken for three days before anyone
// hears. Checked every tick, so it fires even when no further run is due.
export const SCHEDULE_ALERT_AFTER_HOURS: number = envNumber("SCHEDULE_ALERT_AFTER_HOURS", 6);

// Run rows kept per schedule; older ones are pruned after each run.
export const SCHEDULE_RUN_HISTORY: number = envNumber("SCHEDULE_RUN_HISTORY", 100);

// How much of the app's response body a run row keeps.
export const SCHEDULE_RESPONSE_EXCERPT_BYTES: number = envNumber("SCHEDULE_RESPONSE_EXCERPT_BYTES", 2048);

// Where the runner connects. Calls go straight to the origin, with the
// app's own hostname for TLS and routing, rather than through the CDN in
// front of the app domain: the CDN cuts a response off at ~100s, which a
// cold start (up to 90s) plus any real work would routinely exceed.
export const SCHEDULE_TARGET_IP: string = process.env.SCHEDULE_TARGET_IP?.trim() || ORIGIN_SERVER_IP;
export const SCHEDULE_TARGET_PORT: number = envNumber("SCHEDULE_TARGET_PORT", 443);
