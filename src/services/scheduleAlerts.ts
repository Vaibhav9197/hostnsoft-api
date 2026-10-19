/**
 * Tells someone when a schedule starts failing and when it recovers — one
 * message each way, never one per failed run. Two destinations, both
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
import { platformAppUrl } from "./showcase";
import { toRunResponse } from "./schedules";

export type ScheduleAlertEvent = "schedule.failed" | "schedule.recovered";

interface AlertInput {
  event: ScheduleAlertEvent;
  schedule: Schedule;
  run: ScheduleRun;
  project: { slug: string; createdBy: string | null };
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
  return schedule.name ? `"${schedule.name}"` : `${schedule.path} (${schedule.cron})`;
}

function renderEmail({ event, schedule, run, project }: AlertInput): { subject: string; html: string } {
  const app = project.slug;
  const failed = event === "schedule.failed";
  const subject = failed
    ? `Scheduled run failing on ${app}`
    : `Scheduled run recovered on ${app}`;
  const what = failed
    ? `The scheduled call ${escapeHtml(label(schedule))} on <b>${escapeHtml(app)}</b> failed.`
    : `The scheduled call ${escapeHtml(label(schedule))} on <b>${escapeHtml(app)}</b> is working again.`;
  const detail = failed
    ? `<p style="margin:0 0 12px 0;">Reason: <code>${escapeHtml(run.error ?? "unknown")}</code></p>
       <p style="margin:0 0 12px 0;">It will keep running on schedule. You'll get one more email when it recovers, not one per failed run.</p>
       <p style="margin:0;">To fix it, ask the AI agent that built the app to check this schedule's recent runs.</p>`
    : `<p style="margin:0;">No action needed.</p>`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; line-height:1.6; color:#1f2328; max-width:600px;">
  <p style="margin:0 0 12px 0;">${what}</p>
  <p style="margin:0 0 12px 0;">Calls <code>GET ${escapeHtml(platformAppUrl(app) + schedule.path)}</code> on <code>${escapeHtml(schedule.cron)}</code> (${escapeHtml(schedule.timezone)}).</p>
  ${detail}
</div>`;
  return { subject, html };
}

async function sendEmail(input: AlertInput): Promise<void> {
  const ownerId = input.project.createdBy ?? input.schedule.createdBy;
  const owner = await getUserById(ownerId).catch(() => null);
  if (!owner?.email) {
    logger.warn(`[scheduleAlerts] no email for owner of "${input.project.slug}"; ${input.event} not mailed`);
    return;
  }
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
