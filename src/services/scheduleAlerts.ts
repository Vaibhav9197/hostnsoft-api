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
import cronstrue from "cronstrue";
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
  // schedule.recovered only: how many runs had failed in a row before it.
  failedInARow?: number;
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

// "every 5 minutes", "at 09:00, Monday through Friday" — same wording the
// dashboard's jobs list uses (cronstrue there too). Null if unreadable.
function describeTiming(cron: string): string | null {
  try {
    const words = cronstrue.toString(cron, { use24HourTimeFormat: true, verbose: false });
    return words.charAt(0).toLowerCase() + words.slice(1);
  } catch {
    return null;
  }
}

// What went wrong, for someone who didn't write the app. The raw error
// still goes to the AI, inside the prompt.
function plainReason(run: ScheduleRun): string {
  const error = run.error ?? "";
  const status = run.httpStatus ?? 0;
  if (error.startsWith("Could not reach the app")) return "Embarko couldn't connect to your app.";
  if (error.startsWith("No complete response")) return "Your app took too long to answer (more than 5 minutes).";
  if (status >= 300 && status < 400) return "Your app sent the job somewhere else instead of doing it.";
  if (status === 404) return "Your app no longer has the page this job calls. It may have been renamed or removed.";
  if (status === 401 || status === 403) return "Your app refused the job, as if it needed a login or a password.";
  if (status === 503 || status === 502) return "Your app wasn't ready to answer, or it crashed while starting.";
  if (status >= 500) return "Your app ran into an error while doing this job.";
  if (status >= 400) return "Your app rejected the job's request.";
  return "The job didn't finish successfully.";
}

// The prompt the "Fix with your AI" button hands over. Keep in step with
// the dashboard's consoleFixSchedulePrompt (hostnsoft app/lib/deployPrompt.ts):
// same instructions, plus how long the streak has run, which only this
// side knows.
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

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

const TONE = {
  failed: { label: "Needs attention", fg: "#b42318", bg: "#fef3f2", border: "#fecdca" },
  recovered: { label: "Working again", fg: "#067647", bg: "#ecfdf3", border: "#abefc6" },
};

// Email-safe layout (tables + inline styles), same look as the showcase and
// deploy-token mails. title, body and footer are already-escaped HTML.
function layout(o: {
  tone: (typeof TONE)[keyof typeof TONE];
  title: string;
  body: string;
  cta: { url: string; label: string; icon?: string };
  after?: string;
  footer: string;
}): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${FONT} background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; text-align:left;">
        <tr><td style="padding:0 0 28px 0;">
          <a href="${escapeHtml(FRONTEND_ORIGIN)}" style="text-decoration:none; color:#1f2328;">
            <img src="${escapeHtml(FRONTEND_ORIGIN)}/assets/android-chrome-192x192.png" width="28" height="28" alt="" style="display:inline-block; vertical-align:middle; border:0;">
            <span style="${FONT} display:inline-block; vertical-align:middle; margin-left:8px; font-size:16px; font-weight:700; color:#1f2328;">Embarko</span>
          </a>
        </td></tr>
        <tr><td style="padding:0 0 14px 0;">
          <span style="${FONT} display:inline-block; padding:4px 12px; border-radius:999px; border:1px solid ${o.tone.border}; background:${o.tone.bg}; color:${o.tone.fg}; font-size:12px; font-weight:600;">${o.tone.label}</span>
        </td></tr>
        <tr><td style="padding:0 0 14px 0; font-size:22px; line-height:1.35; font-weight:700; color:#1f2328;">${o.title}</td></tr>
        <tr><td style="padding:0; font-size:15px; line-height:1.6; color:#2c3e50;">${o.body}</td></tr>
        <tr><td style="padding:24px 0 8px 0;">
          <a href="${escapeHtml(o.cta.url)}" style="${FONT} display:inline-block; background:#1f2328; color:#ffffff; font-size:15px; font-weight:600; text-decoration:none; padding:13px 22px; border-radius:8px;">${o.cta.icon ? `${o.cta.icon}&nbsp; ` : ""}${escapeHtml(o.cta.label)}</a>
        </td></tr>
        ${o.after ? `<tr><td style="padding:16px 0 0 0;">${o.after}</td></tr>` : ""}
        <tr><td style="padding:28px 0 0 0;"><div style="border-top:1px solid #e6e8eb; padding-top:16px; font-size:12px; line-height:1.6; color:#8c959f;">${o.footer}<br>— The Embarko team</div></td></tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

function reasonCallout(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0 0;"><tr>
    <td style="padding:14px 16px; background:#fef3f2; border:1px solid #fecdca; border-radius:8px; font-size:14px; line-height:1.55; color:#7a271a;">
      <b style="color:#b42318;">What went wrong:</b> ${escapeHtml(text)}
    </td>
  </tr></table>`;
}

// The prompt again, in the email itself, for whoever reads mail where the
// dashboard isn't handy (a phone, someone else's laptop).
function promptBox(prompt: string): string {
  return `<p style="margin:0 0 8px 0; font-size:13px; line-height:1.5; color:#656d76;">Can't open the dashboard? Copy this message and paste it into the AI that built your app:</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="padding:14px 16px; background:#f6f8fa; border:1px solid #e6e8eb; border-radius:8px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.55; color:#2c3e50; white-space:pre-wrap; word-break:break-word;">${escapeHtml(prompt)}</td>
  </tr></table>`;
}

async function renderEmail(input: AlertInput): Promise<{ subject: string; html: string }> {
  const { event, schedule, run, project } = input;
  const app = project.slug;
  const name = label(schedule);
  const timing = describeTiming(schedule.cron);
  const appPage = `${FRONTEND_ORIGIN}/app/projects/${encodeURIComponent(project.id)}`;

  if (event === "schedule.failed") {
    const n = schedule.consecutiveFailures;
    const when = schedule.failingSince ? escapeHtml(formatTime(schedule.failingSince, schedule.timezone)) : null;
    const tries =
      n <= 1
        ? `its last try${when ? `, at ${when},` : ""} failed`
        : `its last ${n} tries failed${when ? `, starting ${when}` : ""}`;
    const body = `<p style="margin:0;">Your app <b>${escapeHtml(app)}</b> has a job that runs on its own${timing ? `, ${escapeHtml(timing)}` : ""}: <b>${escapeHtml(name)}</b>. It has stopped working: ${tries}.</p>
      ${reasonCallout(plainReason(run))}
      <p style="margin:18px 0 0 0;">You don't need to fix this yourself. Click the button, then paste into the AI that built your app. It gets everything it needs to find the problem and put it right.</p>`;
    const html = layout({
      tone: TONE.failed,
      title: `A scheduled job in ${escapeHtml(app)} stopped working`,
      body,
      cta: { url: `${appPage}?fix=${encodeURIComponent(schedule.id)}`, label: "Fix with your AI", icon: "&#10024;" },
      after: promptBox(fixPrompt(schedule, run, app)),
      footer: `We'll email you once it's working again. You're getting this because you own ${escapeHtml(app)} on Embarko.`,
    });
    return { subject: `Needs attention: a scheduled job in ${app} stopped working`, html };
  }

  const n = input.failedInARow ?? 0;
  const html = layout({
    tone: TONE.recovered,
    title: `${escapeHtml(name)} is working again`,
    body: `<p style="margin:0;">Good news: the scheduled job <b>${escapeHtml(name)}</b> in <b>${escapeHtml(app)}</b> ran successfully at ${escapeHtml(formatTime(run.startedAt, schedule.timezone))}${n > 1 ? `, after ${n} failed tries` : ""}. Nothing to do.</p>`,
    cta: { url: appPage, label: "Open in Embarko" },
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
