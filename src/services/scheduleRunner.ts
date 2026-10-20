/**
 * Makes scheduled calls — see docs/schedules.md.
 *
 * Every SCHEDULE_TICK_MS it picks up enabled schedules whose nextRunAt has
 * passed, advances each one's nextRunAt FIRST (a compare-and-set on the old
 * value, so a second runner process can never fire the same occurrence),
 * then sends GET <path> to the app. A sleeping app is woken by that request
 * exactly as a visitor would wake it; nothing here knows about sleep.
 *
 * Missed occurrences (this service was down) are not replayed one by one:
 * an overdue schedule runs once, then resumes from the next occurrence after
 * now. A schedule whose previous run is still in flight records a "skipped"
 * run instead of overlapping it.
 *
 * In-flight tracking is per process, like services/renameStatus.ts. Run as
 * a single instance; a second instance would still never double-fire an
 * occurrence, but could overlap a slow run with the next one.
 */
import https from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import type { Schedule, ScheduleRun } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import {
  SCHEDULE_MAX_CONCURRENT_RUNS,
  SCHEDULE_RESPONSE_EXCERPT_BYTES,
  SCHEDULE_RUN_HISTORY,
  SCHEDULE_RUN_TIMEOUT_MS,
  SCHEDULE_TARGET_IP,
  SCHEDULE_TARGET_PORT,
  SCHEDULE_TICK_MS,
} from "../lib/scheduleConfig";
import { nextRunAfter } from "./schedules";
import { platformAppUrl } from "./showcase";
import { sendScheduleAlert } from "./scheduleAlerts";
import { CRON_SECRET_KEY } from "./scheduleSync";

// Not a bot pattern match (analytics/bot-filter.js on the deploy side), so
// the call wakes a sleeping app and counts as real traffic.
const USER_AGENT = "Embarko-Scheduler/1.0 (+https://embarko.ai/docs/schedules)";

// CRON_SECRET_KEY: the app's env var that, when set, is sent back as a
// bearer token so the app can tell a real scheduled call from anyone
// requesting the same path. Same name and convention as Vercel's cron.

type ProjectRef = { id: string; slug: string; createdBy: string | null };

const inFlight = new Set<string>();

export function isRunInFlight(scheduleId: string): boolean {
  return inFlight.has(scheduleId);
}

// Resolves the app's own hostname to the origin directly, keeping that
// hostname for TLS (SNI + certificate check) and for routing (Host).
const lookupOrigin: LookupFunction = (_hostname, options, callback) => {
  const family = isIP(SCHEDULE_TARGET_IP) === 6 ? 6 : 4;
  if ((options as { all?: boolean }).all) {
    (callback as unknown as (err: null, addrs: { address: string; family: number }[]) => void)(null, [
      { address: SCHEDULE_TARGET_IP, family },
    ]);
  } else {
    callback(null, SCHEDULE_TARGET_IP, family);
  }
};

interface CallResult {
  httpStatus: number | null;
  error: string | null;
  responseExcerpt: string | null;
}

function callApp(slug: string, path: string, headers: Record<string, string>): Promise<CallResult> {
  const host = new URL(platformAppUrl(slug)).hostname;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: CallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const req = https.request(
      { host, port: SCHEDULE_TARGET_PORT, servername: host, path, method: "GET", headers: { ...headers, host }, lookup: lookupOrigin },
      (res) => {
        const chunks: Buffer[] = [];
        let kept = 0;
        res.on("data", (chunk: Buffer) => {
          if (kept < SCHEDULE_RESPONSE_EXCERPT_BYTES) {
            const slice = chunk.subarray(0, SCHEDULE_RESPONSE_EXCERPT_BYTES - kept);
            chunks.push(slice);
            kept += slice.length;
          }
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const excerpt = Buffer.concat(chunks).toString("utf8") || null;
          let error: string | null = null;
          if (status >= 300 && status < 400) {
            error = `HTTP ${status}: redirected to ${res.headers.location ?? "(no location)"}. Schedules don't follow redirects; point the schedule at the final path.`;
          } else if (status < 200 || status >= 300) {
            error = `HTTP ${status}`;
          }
          finish({ httpStatus: status, error, responseExcerpt: excerpt });
        });
        res.on("error", (e) => finish({ httpStatus: res.statusCode ?? null, error: e.message, responseExcerpt: null }));
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish({
        httpStatus: null,
        error: `No complete response within ${Math.round(SCHEDULE_RUN_TIMEOUT_MS / 1000)}s. Reply sooner and finish the work in the background.`,
        responseExcerpt: null,
      });
    }, SCHEDULE_RUN_TIMEOUT_MS);

    req.on("error", (e) => finish({ httpStatus: null, error: `Could not reach the app: ${e.message}`, responseExcerpt: null }));
    req.end();
  });
}

async function cronSecretFor(projectId: string): Promise<string | null> {
  const row = await prisma.envVar.findUnique({
    where: { projectId_key: { projectId, key: CRON_SECRET_KEY } },
    select: { value: true },
  });
  return row?.value || null;
}

async function pruneRuns(scheduleId: string): Promise<void> {
  const stale = await prisma.scheduleRun.findMany({
    where: { scheduleId },
    orderBy: { startedAt: "desc" },
    skip: SCHEDULE_RUN_HISTORY,
    select: { id: true },
  });
  if (stale.length) await prisma.scheduleRun.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
}

// Failure state + alerts. One alert on the first failure, one on recovery.
async function settleFailureState(schedule: Schedule, run: ScheduleRun, project: ProjectRef): Promise<void> {
  if (run.outcome === "failed") {
    const updated = await prisma.schedule.update({
      where: { id: schedule.id },
      data: { consecutiveFailures: { increment: 1 }, failing: true },
    });
    if (!schedule.failing) await sendScheduleAlert({ event: "schedule.failed", schedule: updated, run, project });
  } else if (run.outcome === "ok" && (schedule.failing || schedule.consecutiveFailures > 0)) {
    const updated = await prisma.schedule.update({
      where: { id: schedule.id },
      data: { consecutiveFailures: 0, failing: false },
    });
    if (schedule.failing) await sendScheduleAlert({ event: "schedule.recovered", schedule: updated, run, project });
  }
}

async function execute(schedule: Schedule, project: ProjectRef, run: ScheduleRun): Promise<void> {
  const started = Date.now();
  let finished: ScheduleRun = run;
  try {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "x-embarko-schedule-id": schedule.id,
      "x-embarko-run-id": run.id,
    };
    const secret = await cronSecretFor(project.id);
    if (secret) headers.authorization = `Bearer ${secret}`;

    const result = await callApp(project.slug, schedule.path, headers);
    finished = await prisma.scheduleRun.update({
      where: { id: run.id },
      data: {
        outcome: result.error ? "failed" : "ok",
        httpStatus: result.httpStatus,
        error: result.error,
        responseExcerpt: result.responseExcerpt,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      },
    });
    await settleFailureState(schedule, finished, project);
    await pruneRuns(schedule.id);
  } catch (e) {
    // The schedule may have been deleted mid-run (cascade took the run row).
    logger.error(`[scheduleRunner] run ${run.id} of schedule ${schedule.id} ("${project.slug}"): ${(e as Error).message}`);
  } finally {
    inFlight.delete(schedule.id);
  }
}

/**
 * Starts one run now and returns its row without waiting for the call.
 * Returns null when the schedule's previous run is still in flight (the
 * caller records or reports that).
 */
export async function startRun(
  schedule: Schedule,
  project: ProjectRef,
  trigger: "schedule" | "manual"
): Promise<ScheduleRun | null> {
  if (inFlight.has(schedule.id)) return null;
  inFlight.add(schedule.id);
  let run: ScheduleRun;
  try {
    run = await prisma.scheduleRun.create({ data: { scheduleId: schedule.id, trigger, outcome: "running" } });
  } catch (e) {
    inFlight.delete(schedule.id);
    throw e;
  }
  void execute(schedule, project, run);
  return run;
}

async function tick(): Promise<void> {
  const capacity = SCHEDULE_MAX_CONCURRENT_RUNS - inFlight.size;
  if (capacity <= 0) return;

  const now = new Date();
  const due = await prisma.schedule.findMany({
    where: { enabled: true, nextRunAt: { lte: now }, project: { kind: { not: "static" } } },
    orderBy: { nextRunAt: "asc" },
    take: capacity,
    include: { project: { select: { id: true, slug: true, createdBy: true } } },
  });

  for (const { project, ...schedule } of due) {
    let next: Date | null;
    try {
      next = nextRunAfter(schedule.cron, schedule.timezone, now);
    } catch (e) {
      // Validated on write, so only reachable if the stored row was edited
      // by hand. Park it rather than retrying every tick.
      logger.error(`[scheduleRunner] schedule ${schedule.id} has an unusable cron "${schedule.cron}": ${(e as Error).message}`);
      next = null;
    }

    const claimed = await prisma.schedule.updateMany({
      where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
      data: { nextRunAt: next },
    });
    if (claimed.count === 0 || !next) continue;

    const run = await startRun(schedule, project, "schedule");
    if (!run) {
      await prisma.scheduleRun.create({
        data: {
          scheduleId: schedule.id,
          outcome: "skipped",
          error: "The previous run was still in progress, so this occurrence was skipped.",
          finishedAt: new Date(),
          durationMs: 0,
        },
      });
    }
  }
}

export function startScheduleRunner(): void {
  // Runs left "running" by a previous process will never finish; say so
  // rather than leaving them looking live forever.
  prisma.scheduleRun
    .updateMany({
      where: { outcome: "running" },
      data: { outcome: "failed", error: "Interrupted: the scheduler restarted during this run.", finishedAt: new Date() },
    })
    .catch((e) => logger.error(`[scheduleRunner] could not close interrupted runs: ${(e as Error).message}`));

  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    tick()
      .catch((e) => logger.error(`[scheduleRunner] tick failed: ${(e as Error).message}`))
      .finally(() => {
        busy = false;
      });
  }, SCHEDULE_TICK_MS).unref(); // .unref(): don't keep the process alive on shutdown
}
