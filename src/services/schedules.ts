/**
 * Schedules: validation, timing and the response shape — see
 * docs/schedules.md. The runner that actually makes the calls is
 * services/scheduleRunner.ts.
 */
import parser, { type CronExpression } from "cron-parser";
import { z } from "zod";
import type { Schedule, ScheduleRun } from "@prisma/client";
import { platformAppUrl } from "./showcase";
import { parsePublicHttpsUrl } from "../lib/publicHttpsUrl";
import { SCHEDULE_MIN_INTERVAL_MS, SCHEDULE_RUN_HISTORY } from "../lib/scheduleConfig";
import { prisma } from "../lib/prisma";

export class ScheduleValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

// The shorthands people and agents actually type, mapped to the five-field
// form they mean. Stored expanded, so what an agent reads back is what runs.
const SHORTHANDS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function normalizeCron(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const expanded = SHORTHANDS[trimmed.toLowerCase()] ?? trimmed;
  // Five fields only. cron-parser also takes a leading seconds field, which
  // would let a schedule run more often than the minimum interval check
  // below samples for, and isn't standard cron anyway.
  if (expanded.split(" ").length !== 5) {
    throw new ScheduleValidationError(
      `"${raw}" is not a five-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5".`,
      "invalid_cron"
    );
  }
  return expanded;
}

export function nextRunAfter(cron: string, timezone: string, after: Date): Date {
  return parser.parseExpression(cron, { currentDate: after, tz: timezone }).next().toDate();
}

// Parses, and enforces the minimum gap by sampling the next occurrences.
// Sampling rather than reasoning about the fields: "*/3 * * * *", "0-4 * * * *"
// and "0,2 * * * *" are all too frequent in different ways, and the next
// 60 occurrences catch every one of them.
export function validateTiming(cron: string, timezone: string): void {
  if (!isValidTimezone(timezone)) {
    throw new ScheduleValidationError(
      `"${timezone}" is not a known time zone. Use an IANA name such as "UTC" or "Asia/Kolkata".`,
      "invalid_timezone"
    );
  }
  let it: CronExpression;
  try {
    it = parser.parseExpression(cron, { currentDate: new Date(), tz: timezone });
  } catch (e) {
    throw new ScheduleValidationError(`"${cron}" is not a valid cron expression: ${(e as Error).message}`, "invalid_cron");
  }
  let prev = it.next().toDate().getTime();
  for (let i = 0; i < 60; i++) {
    const cur = it.next().toDate().getTime();
    if (cur - prev < SCHEDULE_MIN_INTERVAL_MS) {
      throw new ScheduleValidationError(
        `"${cron}" runs more often than every ${Math.round(SCHEDULE_MIN_INTERVAL_MS / 60000)} minutes, the shortest interval allowed.`,
        "schedule_too_frequent"
      );
    }
    prev = cur;
  }
}

export function validatePath(raw: string): string {
  const path = raw.trim();
  // A path on the app's own host, nothing else: no scheme, no other host
  // ("//evil.example" is protocol-relative), no fragment, no whitespace.
  if (!path.startsWith("/") || path.startsWith("//") || /[\s#\\]/.test(path) || path.length > 512) {
    throw new ScheduleValidationError(
      `"${raw}" is not a path on the app. Use one starting with "/", e.g. "/tasks/daily-digest".`,
      "invalid_path"
    );
  }
  const probe = new URL(path, "https://app.invalid");
  if (probe.host !== "app.invalid") {
    throw new ScheduleValidationError(`"${raw}" is not a path on the app.`, "invalid_path");
  }
  return probe.pathname + probe.search;
}

const webhookUrl = z
  .string()
  .max(2048)
  .refine(
    (v) => {
      try {
        parsePublicHttpsUrl(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Must be a public https:// URL" }
  );

export const createScheduleSchema = z.object({
  cron: z.string().min(1).max(100),
  path: z.string().min(1).max(512),
  timezone: z.string().min(1).max(64).optional().default("UTC"),
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional().default(true),
  alertWebhookUrl: webhookUrl.optional(),
});

// Every field optional; null clears the two clearable ones.
export const updateScheduleSchema = z.object({
  cron: z.string().min(1).max(100).optional(),
  path: z.string().min(1).max(512).optional(),
  timezone: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100).nullable().optional(),
  enabled: z.boolean().optional(),
  alertWebhookUrl: webhookUrl.nullable().optional(),
});

export function toRunResponse(run: ScheduleRun) {
  return {
    id: run.id,
    trigger: run.trigger,
    outcome: run.outcome,
    terminal: run.outcome !== "running",
    httpStatus: run.httpStatus,
    error: run.error,
    responseExcerpt: run.responseExcerpt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
  };
}

// The one shape for a schedule, used by list, get, create and update alike.
// `runs` is the newest run only (include: LAST_RUN below), or empty.
export function toScheduleResponse(schedule: Schedule & { runs: ScheduleRun[] }, slug: string) {
  return {
    id: schedule.id,
    name: schedule.name,
    cron: schedule.cron,
    timezone: schedule.timezone,
    path: schedule.path,
    url: platformAppUrl(slug) + schedule.path,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt,
    failing: schedule.failing,
    consecutiveFailures: schedule.consecutiveFailures,
    // Never the URL itself: a Slack/Discord webhook URL is a credential.
    alertWebhook: schedule.alertWebhookUrl
      ? { set: true, host: new URL(schedule.alertWebhookUrl).host }
      : { set: false, host: null },
    lastRun: schedule.runs[0] ? toRunResponse(schedule.runs[0]) : null,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    links: {
      runNow: `/api/apps/${slug}/schedules/${schedule.id}/run`,
      runs: `/api/apps/${slug}/schedules/${schedule.id}/runs`,
    },
  };
}

export const LAST_RUN = { runs: { orderBy: { startedAt: "desc" as const }, take: 1 } };

// The `schedules` field on every project response (list, get-one, claim):
// how many the app has and how many are failing, so the dashboard can say
// "Needs attention" without a call per app. One grouped query for any
// number of projects.
export type ScheduleSummary = { count: number; failing: number };

export async function scheduleSummaries(projectIds: string[]): Promise<Map<string, ScheduleSummary>> {
  const out = new Map<string, ScheduleSummary>(projectIds.map((id) => [id, { count: 0, failing: 0 }]));
  if (projectIds.length === 0) return out;
  const rows = await prisma.schedule.groupBy({
    by: ["projectId", "failing"],
    where: { projectId: { in: projectIds } },
    _count: { _all: true },
  });
  for (const row of rows) {
    const s = out.get(row.projectId)!;
    s.count += row._count._all;
    if (row.failing) s.failing += row._count._all;
  }
  return out;
}

// Run history, one page at a time, newest first, for the agent API and the
// dashboard alike. Page numbers rather than cursors: a schedule keeps at
// most SCHEDULE_RUN_HISTORY runs, so a total and an offset are cheap and
// let the panel say "page 2 of 5". `outcome` and `trigger` filter.
export const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).default(1),
  outcome: z.enum(["ok", "failed", "skipped", "running"]).optional(),
  trigger: z.enum(["schedule", "manual"]).optional(),
});

export async function listRuns(scheduleId: string, query: z.infer<typeof runsQuerySchema>) {
  const where = {
    scheduleId,
    ...(query.outcome && { outcome: query.outcome }),
    ...(query.trigger && { trigger: query.trigger }),
  };
  const [total, runs] = await Promise.all([
    prisma.scheduleRun.count({ where }),
    prisma.scheduleRun.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);
  return {
    runs: runs.map(toRunResponse),
    page: query.page,
    pageSize: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
    // How many runs are kept per schedule, so a reader knows why the
    // history starts where it does.
    kept: SCHEDULE_RUN_HISTORY,
  };
}

export async function scheduleSummary(projectId: string): Promise<ScheduleSummary> {
  return (await scheduleSummaries([projectId])).get(projectId)!;
}

// ------------------------------------------------------------------
// Schedules declared in the app's embarko.json, which the deploy carries —
// see docs/schedules.md "Declared on deploy". The list is the app's whole
// set: checked at claim time, before any build, and applied only once that
// deploy succeeds.

const declaredScheduleSchema = z.object({
  cron: z.string().min(1).max(100),
  path: z.string().min(1).max(512),
  timezone: z.string().min(1).max(64).optional().default("UTC"),
  name: z.string().trim().min(1).max(100).optional(),
});

export const declaredSchedulesSchema = z.array(declaredScheduleSchema);

export type DeclaredSchedule = { cron: string; path: string; timezone: string; name?: string };

// Throws ScheduleValidationError naming which entry is wrong, so the agent
// can fix the header from the message alone.
export function validateDeclaredSchedules(raw: unknown, max: number): DeclaredSchedule[] {
  const parsed = declaredSchedulesSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ScheduleValidationError(
      `In embarko.json, "schedules" must be a list like [{"cron":"0 9 * * 1-5","path":"/tasks/daily","timezone":"Asia/Kolkata"}]` +
        ` (${issue.path.join(".") || "list"}: ${issue.message}).`,
      "invalid_schedules"
    );
  }
  if (parsed.data.length > max) {
    throw new ScheduleValidationError(`embarko.json lists ${parsed.data.length} schedules; an app can have at most ${max}.`, "schedule_limit_reached");
  }
  const seen = new Set<string>();
  return parsed.data.map((s, i) => {
    const at = (e: unknown) => {
      if (e instanceof ScheduleValidationError) throw new ScheduleValidationError(`Schedule ${i + 1}: ${e.message}`, e.code);
      throw e;
    };
    try {
      const cron = normalizeCron(s.cron);
      validateTiming(cron, s.timezone);
      const path = validatePath(s.path);
      if (seen.has(path)) {
        throw new ScheduleValidationError(`"${path}" is listed twice. Give each schedule its own path.`, "duplicate_schedule_path");
      }
      seen.add(path);
      return { cron, path, timezone: s.timezone, ...(s.name ? { name: s.name } : {}) };
    } catch (e) {
      return at(e);
    }
  });
}
