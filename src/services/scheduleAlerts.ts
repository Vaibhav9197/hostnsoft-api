/**
 * Tells someone when a schedule starts failing (SCHEDULE_ALERT_AFTER_FAILURES
 * runs in a row, or a streak SCHEDULE_ALERT_AFTER_HOURS old) and when it
 * recovers — one message each way, never one per
 * failed run. Two destinations, both
 * best-effort (a failed alert is logged, never retried, and never changes
 * the run's own outcome):
 *   - email to the app's owner (the person who created the project),
 *     through the same viaSocket email flow the token mail uses;
 *   - the schedule's optional alert webhook, as JSON.
 * See docs/schedules.md "Alerts" for the webhook payload.
 */
import type { Schedule, ScheduleRun } from "@prisma/client";
import { callWebhook, Webhook } from "../lib/webhooks";
import { getUserById } from "../lib/msg91";
import { assertPublicHttpsUrl } from "../lib/publicHttpsUrl";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";
import { platformAppUrl } from "./showcase";
import { toRunResponse } from "./schedules";

export type ScheduleAlertEvent = "schedule.failed" | "schedule.recovered";

interface AlertInput {
  event: ScheduleAlertEvent;
  schedule: Schedule;
  run: ScheduleRun;
  project: { id: string; slug: string; createdBy: string | null };
  // schedule.recovered only: how many runs had failed in a row before it.
  failedInARow?: number;
}

const WEBHOOK_TIMEOUT_MS = 10_000;

// Failed runs listed in the "failing" email, newest first.
const RECENT_FAILURES_SHOWN = 5;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function label(schedule: Schedule): string {
  return schedule.name ? `"${schedule.name}"` : schedule.path;
}

// In the schedule's own timezone, since that's the one its cron is read in.
function formatTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;";

const TONE = {
  failed: { label: "Failing", fg: "#b42318", bg: "#fef3f2", border: "#fecdca" },
  recovered: { label: "Working again", fg: "#067647", bg: "#ecfdf3", border: "#abefc6" },
};

// Email-safe layout (tables + inline styles), same look as the showcase and
// deploy-token mails. Every argument is already-escaped HTML.
function layout(o: { tone: (typeof TONE)[keyof typeof TONE]; title: string; body: string; cta: { url: string; label: string }; footer: string }): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${FONT} background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; text-align:left;">
        <tr><td style="padding:0 0 24px 0;">
          <a href="${escapeHtml(FRONTEND_ORIGIN)}" style="text-decoration:none; color:#1f2328;">
            <img src="${escapeHtml(FRONTEND_ORIGIN)}/assets/android-chrome-192x192.png" width="28" height="28" alt="" style="display:inline-block; vertical-align:middle; border:0;">
            <span style="${FONT} display:inline-block; vertical-align:middle; margin-left:8px; font-size:16px; font-weight:700; color:#1f2328;">Embarko</span>
          </a>
        </td></tr>
        <tr><td style="padding:0 0 12px 0;">
          <span style="${FONT} display:inline-block; padding:3px 10px; border-radius:999px; border:1px solid ${o.tone.border}; background:${o.tone.bg}; color:${o.tone.fg}; font-size:12px; font-weight:600;">${o.tone.label}</span>
        </td></tr>
        <tr><td style="padding:0 0 12px 0; font-size:20px; line-height:1.4; font-weight:600; color:#1f2328;">${o.title}</td></tr>
        <tr><td style="padding:0 0 8px 0; font-size:14px; line-height:1.6; color:#2c3e50;">${o.body}</td></tr>
        <tr><td style="padding:16px 0 24px 0;">
          <a href="${escapeHtml(o.cta.url)}" style="${FONT} display:inline-block; background:#1f2328; color:#ffffff; font-size:14px; font-weight:600; text-decoration:none; padding:10px 18px; border-radius:6px;">${escapeHtml(o.cta.label)}</a>
        </td></tr>
        <tr><td style="padding:16px 0 0 0; border-top:1px solid #e6e8eb; font-size:12px; line-height:1.6; color:#8c959f;">${o.footer}<br>— The Embarko team</td></tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

// Label / value rows in a light box: what the schedule is.
function detailsBox(rows: [string, string][]): string {
  const body = rows
    .map(
      ([k, v]) => `<tr>
        <td style="padding:6px 16px 6px 0; font-size:13px; color:#656d76; white-space:nowrap; vertical-align:top;">${k}</td>
        <td style="padding:6px 0; font-size:13px; color:#1f2328; word-break:break-all;">${v}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0; background:#f6f8fa; border:1px solid #e6e8eb; border-radius:8px;">
    <tr><td style="padding:10px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${body}</table></td></tr>
  </table>`;
}

function failuresList(runs: ScheduleRun[], timezone: string): string {
  if (runs.length === 0) return "";
  const rows = runs
    .map(
      (r) => `<tr>
        <td style="padding:10px 12px; border-top:1px solid #f0f1f3; font-size:13px; color:#656d76; white-space:nowrap; vertical-align:top;">${escapeHtml(formatTime(r.startedAt, timezone))}</td>
        <td style="padding:10px 12px; border-top:1px solid #f0f1f3; ${MONO} font-size:12px; line-height:1.5; color:#b42318; word-break:break-word;">${escapeHtml(r.error ?? (r.httpStatus ? `HTTP ${r.httpStatus}` : "unknown"))}</td>
      </tr>`
    )
    .join("");
  return `<p style="margin:20px 0 8px 0; font-size:14px; font-weight:600; color:#1f2328;">Recent failed runs</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e6e8eb; border-radius:8px; border-collapse:separate;">
    <tr>
      <td width="150" style="padding:8px 12px; font-size:12px; font-weight:600; color:#656d76; background:#f6f8fa; border-radius:8px 0 0 0;">When</td>
      <td style="padding:8px 12px; font-size:12px; font-weight:600; color:#656d76; background:#f6f8fa; border-radius:0 8px 0 0;">What went wrong</td>
    </tr>
    ${rows}
  </table>`;
}

async function renderEmail(input: AlertInput): Promise<{ subject: string; html: string }> {
  const { event, schedule, run, project } = input;
  const app = project.slug;
  const name = label(schedule);
  const failed = event === "schedule.failed";
  const subject = failed
    ? `Scheduled job failing: ${name} on ${app}`
    : `Scheduled job working again: ${name} on ${app}`;

  const details = detailsBox([
    ["App", `<a href="${escapeHtml(platformAppUrl(app))}" style="color:#0969da; text-decoration:none;">${escapeHtml(app)}</a>`],
    ["Calls", `<span style="${MONO}">GET ${escapeHtml(schedule.path)}</span>`],
    ["Runs", `<span style="${MONO}">${escapeHtml(schedule.cron)}</span> (${escapeHtml(schedule.timezone)})`],
  ]);

  let body: string;
  if (failed) {
    const n = schedule.consecutiveFailures;
    // The newest n failed runs are this streak; older ones came before a success.
    const recent = await prisma.scheduleRun.findMany({
      where: { scheduleId: schedule.id, outcome: "failed" },
      orderBy: { startedAt: "desc" },
      take: Math.max(1, Math.min(n, RECENT_FAILURES_SHOWN)),
    });
    const when = schedule.failingSince ? escapeHtml(formatTime(schedule.failingSince, schedule.timezone)) : null;
    const what =
      n <= 1
        ? `This scheduled job failed${when ? ` at <b>${when}</b>` : ""} and hasn't succeeded since.`
        : `This scheduled job has failed <b>${n} runs in a row</b>${when ? ` since ${when}` : ""}, with no successful run in between.`;
    body = `<p style="margin:0;">${what} It keeps running on schedule, and you'll get one more email when it works again.</p>
      ${details}
      ${failuresList(recent.length ? recent : [run], schedule.timezone)}
      <p style="margin:20px 0 0 0;"><b>To fix it,</b> ask the AI agent that built the app to check this schedule's recent runs and fix the route.</p>`;
  } else {
    const n = input.failedInARow ?? 0;
    const after = n > 0 ? ` after ${n} failed run${n === 1 ? "" : "s"} in a row` : "";
    body = `<p style="margin:0;">The run at <b>${escapeHtml(formatTime(run.startedAt, schedule.timezone))}</b> succeeded${after}. No action needed.</p>
      ${details}`;
  }

  const html = layout({
    tone: failed ? TONE.failed : TONE.recovered,
    title: `${escapeHtml(name)} ${failed ? "is failing" : "is working again"} on ${escapeHtml(app)}`,
    body,
    cta: { url: `${FRONTEND_ORIGIN}/app/projects/${encodeURIComponent(project.id)}`, label: "Open in Embarko" },
    footer: `You're getting this because you own ${escapeHtml(app)} on Embarko.`,
  });
  return { subject, html };
}

// Stand-ins written where no person was behind an action (projectClaim.ts
// uses "hostnsoft-deploy" for a project first deployed with a deploy
// token; scheduleSync.ts falls back to "system"). Not proxy users, so
// asking proxy for their email can only fail.
const NOT_A_PERSON = new Set(["hostnsoft-deploy", "system"]);

// Who gets the email: the person who created the app, else the person
// behind the schedule — for a deploy-token deploy, the token's creator
// (scheduleSync / agentApps record that). The first one proxy knows wins.
async function findOwnerEmail(input: AlertInput): Promise<string | null> {
  const candidates = [input.project.createdBy, input.schedule.createdBy].filter(
    (id, i, all): id is string => !!id && !NOT_A_PERSON.has(id) && all.indexOf(id) === i
  );
  for (const id of candidates) {
    const user = await getUserById(id).catch(() => null);
    if (user?.email) return user.email;
  }
  return null;
}

async function sendEmail(input: AlertInput): Promise<void> {
  const email = await findOwnerEmail(input);
  if (!email) {
    logger.warn(
      `[scheduleAlerts] no email for owner of "${input.project.slug}" ` +
        `(project.createdBy=${input.project.createdBy}, schedule.createdBy=${input.schedule.createdBy}); ${input.event} not mailed`
    );
    return;
  }
  const owner = { email };
  const { subject, html } = await renderEmail(input);
  await callWebhook(Webhook.SCHEDULE_ALERT_EMAIL, {
    to: [{ email: owner.email }],
    subject,
    variables: { content: html },
  });
}

async function sendWebhook(input: AlertInput): Promise<void> {
  const raw = input.schedule.alertWebhookUrl;
  if (!raw) return;
  // Re-checked at send time: the host may resolve somewhere private now.
  const url = await assertPublicHttpsUrl(raw);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Embarko-Scheduler/1.0" },
    // Never follow: a redirect is how a public URL would reach a private one.
    redirect: "manual",
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    body: JSON.stringify({
      event: input.event,
      app: { name: input.project.slug, url: platformAppUrl(input.project.slug) },
      schedule: {
        id: input.schedule.id,
        name: input.schedule.name,
        cron: input.schedule.cron,
        timezone: input.schedule.timezone,
        path: input.schedule.path,
      },
      run: toRunResponse(input.run),
      consecutiveFailures: input.schedule.consecutiveFailures,
      sentAt: new Date().toISOString(),
    }),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`alert webhook returned ${res.status}`);
}

export async function sendScheduleAlert(input: AlertInput): Promise<void> {
  const results = await Promise.allSettled([sendEmail(input), sendWebhook(input)]);
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      logger.error(
        `[scheduleAlerts] ${i === 0 ? "email" : "webhook"} for ${input.event} on "${input.project.slug}" ` +
          `(schedule ${input.schedule.id}) failed: ${(r.reason as Error)?.message}`
      );
    }
  });
}
