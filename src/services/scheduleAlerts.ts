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
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";
import { API_PUBLIC_URL } from "../lib/publicTokenConfig";
import { platformAppUrl } from "./showcase";
import { toRunResponse } from "./schedules";

export type ScheduleAlertEvent = "schedule.failed" | "schedule.recovered";

interface AlertInput {
  event: ScheduleAlertEvent;
  schedule: Schedule;
  run: ScheduleRun;
  project: { id: string; slug: string; createdBy: string | null };
}

const WEBHOOK_TIMEOUT_MS = 10_000;

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

// The prompt "Fix with your AI" copies. Keep in step with the dashboard's
// consoleFixSchedulePrompt (hostnsoft app/lib/deployPrompt.ts): same
// instructions, plus how long the streak has run, which only this side knows.
function fixPrompt(schedule: Schedule, run: ScheduleRun, app: string): string {
  const job = schedule.name ?? schedule.path;
  const reply = run.responseExcerpt?.trim().slice(0, 300) || null;
  const lastError = [run.error, reply && reply !== run.error ? `the app replied: ${reply}` : null].filter(Boolean).join("; ");
  const streak = schedule.failingSince
    ? `It has failed ${schedule.consecutiveFailures} run${schedule.consecutiveFailures === 1 ? "" : "s"} in a row, since ${schedule.failingSince.toISOString()}.\n`
    : "";
  return `My Embarko app "${app}" (${platformAppUrl(app)}) has a scheduled job that is failing: ${job} (GET ${schedule.path}).
Last error: ${lastError || "unknown"}.
${streak}
Read ${FRONTEND_ORIGIN}/docs/schedules.md and fix it. Use my deploy token: DEPLOY_TOKEN or ~/.embarko/credentials if either is set; if neither is, ask me for one from ${FRONTEND_ORIGIN}/app/tokens and save it to ~/.embarko/credentials.
Check the job's recent runs at ${API_PUBLIC_URL}/apps/${app}/schedules/${schedule.id}/runs, fix the route in this app's code, then redeploy it as the existing app "${app}" — that exact name. Tell me it's fixed only when the job's test run says "ok".`;
}

// An email can't write to the clipboard, so the button opens the site's
// /fix page, which copies the prompt on arrival. The prompt rides in the
// fragment (base64url JSON, read by hostnsoft app/fix/page.tsx): a fragment
// never reaches a server, so no log keeps the app's error text.
function fixLink(schedule: Schedule, run: ScheduleRun, app: string): string {
  const payload = JSON.stringify({ app, job: schedule.name ?? schedule.path, prompt: fixPrompt(schedule, run, app) });
  return `${FRONTEND_ORIGIN}/fix#${Buffer.from(payload, "utf8").toString("base64url")}`;
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

const TONE = {
  failed: { label: "Needs attention", fg: "#b42318", bg: "#fef3f2", border: "#fecdca" },
  recovered: { label: "Working again", fg: "#067647", bg: "#ecfdf3", border: "#abefc6" },
  request: { label: "Request", fg: "#1f2328", bg: "#f6f8fa", border: "#d0d7de" },
};

// The same layout for a one-off notice from elsewhere (an Integrations
// request). Strings are escaped here; pass plain text.
export function renderNoticeEmail(o: { title: string; body: string; cta: { url: string; label: string }; footer: string }): string {
  return layout({
    tone: TONE.request,
    title: escapeHtml(o.title),
    body: escapeHtml(o.body),
    ctas: [{ ...o.cta, primary: true }],
    footer: escapeHtml(o.footer),
  });
}

type Cta = { url: string; label: string; primary?: boolean };

function button({ url, label, primary }: Cta): string {
  const look = primary
    ? "background:#1f2328; color:#ffffff; border:1px solid #1f2328;"
    : "background:#ffffff; color:#1f2328; border:1px solid #d0d7de;";
  return `<a href="${escapeHtml(url)}" style="${FONT} display:inline-block; ${look} font-size:15px; font-weight:600; text-decoration:none; padding:12px 20px; border-radius:8px; margin:0 8px 8px 0;">${escapeHtml(label)}</a>`;
}

// Email-safe layout (tables + inline styles), same look as the showcase and
// deploy-token mails. title, body and footer are already-escaped HTML.
function layout(o: { tone: (typeof TONE)[keyof typeof TONE]; title: string; body: string; ctas: Cta[]; footer: string }): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${FONT} background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px; text-align:left;">
        <tr><td style="padding:0 0 28px 0;">
          <a href="${escapeHtml(FRONTEND_ORIGIN)}" style="text-decoration:none; color:#1f2328;">
            <img src="${escapeHtml(FRONTEND_ORIGIN)}/assets/android-chrome-192x192.png" width="28" height="28" alt="" style="display:inline-block; vertical-align:middle; border:0;">
            <span style="${FONT} display:inline-block; vertical-align:middle; margin-left:8px; font-size:16px; font-weight:700; color:#1f2328;">Embarko</span>
          </a>
        </td></tr>
        <tr><td style="padding:0 0 14px 0;">
          <span style="${FONT} display:inline-block; padding:4px 12px; border-radius:999px; border:1px solid ${o.tone.border}; background:${o.tone.bg}; color:${o.tone.fg}; font-size:12px; font-weight:600;">${o.tone.label}</span>
        </td></tr>
        <tr><td style="padding:0 0 10px 0; font-size:22px; line-height:1.35; font-weight:700; color:#1f2328;">${o.title}</td></tr>
        <tr><td style="padding:0; font-size:15px; line-height:1.6; color:#2c3e50;">${o.body}</td></tr>
        <tr><td style="padding:22px 0 0 0;">${o.ctas.map(button).join("")}</td></tr>
        <tr><td style="padding:20px 0 0 0;"><div style="border-top:1px solid #e6e8eb; padding-top:14px; font-size:12px; line-height:1.6; color:#8c959f;">${o.footer}</div></td></tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

function renderEmail(input: AlertInput): { subject: string; html: string } {
  const { event, schedule, run, project } = input;
  const app = project.slug;
  const name = label(schedule);
  const dashboard = { url: `${FRONTEND_ORIGIN}/app/projects/${encodeURIComponent(project.id)}`, label: "Open in Embarko" };

  if (event === "schedule.failed") {
    // The dashboard scrolls to this job and marks its fix button.
    dashboard.url += `?fix=${encodeURIComponent(schedule.id)}`;
    const n = schedule.consecutiveFailures;
    const what =
      n <= 1 && schedule.failingSince
        ? `failed and hasn't worked since ${escapeHtml(formatTime(schedule.failingSince, schedule.timezone))}`
        : `failed ${n} times in a row`;
    const html = layout({
      tone: TONE.failed,
      title: `${escapeHtml(name)} stopped working`,
      body: `This scheduled job in <b>${escapeHtml(app)}</b> ${what}. Your AI can fix it: tap the button, then paste into your AI.`,
      ctas: [{ url: fixLink(schedule, run, app), label: "✨ Fix with your AI", primary: true }, dashboard],
      footer: `We'll email you when it works again.`,
    });
    return { subject: `Needs attention: ${name} stopped working in ${app}`, html };
  }

  const html = layout({
    tone: TONE.recovered,
    title: `${escapeHtml(name)} is working again`,
    body: `This scheduled job in <b>${escapeHtml(app)}</b> ran fine at ${escapeHtml(formatTime(run.startedAt, schedule.timezone))}. Nothing to do.`,
    ctas: [dashboard],
    footer: `You're getting this because you own ${escapeHtml(app)} on Embarko.`,
  });
  return { subject: `Working again: ${name} in ${app}`, html };
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
  const { subject, html } = renderEmail(input);
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
