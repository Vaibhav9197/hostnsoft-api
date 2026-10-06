/**
 * Showcase notification mails. Every function here swallows failures —
 * a mail that doesn't go out must never fail the submit or review request.
 * Delivery is the same viasocket flow as the contact mail (`to`, `subject`,
 * `variables.content`).
 */
import type { AppDetails, Project, ShowcaseEvent, ShowcaseEventListing } from "@prisma/client";
import { Webhook, callWebhook } from "../lib/webhooks";
import { getUserById } from "../lib/msg91";
import { logger } from "../lib/logger";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";

type App = Pick<AppDetails, "contributorEmails"> & { project: Pick<Project, "name" | "slug"> };

// Same as showcase.ts parseTags; duplicated to avoid a circular import.
function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

// Email-safe layout (tables + inline styles), same look as the deploy-token
// mail. `body` rows are already-escaped HTML.
function layout(o: { title: string; body: string; cta?: { url: string; label: string }; footer: string }): string {
  const cta = o.cta
    ? `<tr><td style="padding:4px 0 20px 0;">
          <a href="${esc(o.cta.url)}" style="${FONT} display:inline-block; background:#1f2328; color:#ffffff; font-size:14px; font-weight:600; text-decoration:none; padding:10px 18px; border-radius:6px;">${esc(o.cta.label)}</a>
        </td></tr>`
    : "";
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${FONT} background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px; text-align:left;">
        <tr><td style="padding:0 0 20px 0;">
          <a href="${esc(FRONTEND_ORIGIN)}" style="text-decoration:none; color:#1f2328;">
            <img src="${esc(FRONTEND_ORIGIN)}/assets/android-chrome-192x192.png" width="28" height="28" alt="" style="display:inline-block; vertical-align:middle; border:0;">
            <span style="${FONT} display:inline-block; vertical-align:middle; margin-left:8px; font-size:16px; font-weight:700; color:#1f2328;">Embarko</span>
          </a>
        </td></tr>
        <tr><td style="padding:0 0 16px 0; font-size:20px; font-weight:600; color:#1f2328;">${o.title}</td></tr>
        <tr><td style="padding:0 0 18px 0; font-size:14px; line-height:1.6; color:#2c3e50;">${o.body}</td></tr>
        ${cta}
        <tr><td style="padding:16px 0 0 0; border-top:1px solid #e6e8eb; font-size:12px; line-height:1.6; color:#8c959f;">${o.footer}<br>— The Embarko team</td></tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

function quote(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0;"><tr>
    <td style="padding:12px 14px; background:#f6f8fa; border-left:3px solid #d0d7de; border-radius:0 6px 6px 0; font-size:14px; line-height:1.6; color:#2c3e50; white-space:pre-wrap;">${esc(text)}</td>
  </tr></table>`;
}

async function send(to: string[], subject: string, content: string, what: string): Promise<void> {
  if (to.length === 0) return;
  try {
    await callWebhook(Webhook.SHOWCASE_NOTIFY_EMAIL, { to: to.map((email) => ({ email })), subject, variables: { content } });
  } catch (err) {
    logger.error(`[showcaseMail] ${what} not delivered:`, err);
  }
}

async function emailOfUser(userId: string): Promise<string | null> {
  try {
    return (await getUserById(userId))?.email ?? null;
  } catch (err) {
    logger.error(`[showcaseMail] user lookup failed for ${userId}:`, err);
    return null;
  }
}

// Organiser: a listing is waiting for review.
export async function mailPendingListing(event: ShowcaseEvent, app: App): Promise<void> {
  const to = await emailOfUser(event.createdBy);
  if (!to) return;
  const name = esc(app.project.name);
  const title = esc(event.title);
  await send(
    [to],
    `New submission to ${event.title}: ${app.project.name}`,
    layout({
      title: "A new app is waiting for your review",
      body:
        `<b>${name}</b> has been submitted to your showcase page <b>${title}</b>. ` +
        `It stays hidden from the page until you approve it.`,
      cta: { url: `${FRONTEND_ORIGIN}/app/showcase/${event.id}`, label: "Review submission" },
      footer:
        `You get this because you created the showcase page <b>${title}</b> on Embarko. ` +
        `Share the page's submit code with people you trust so their apps go live without review.`,
    }),
    `pending mail for ${app.project.slug} @ ${event.slug}`
  );
}

// Contributor addresses, or the submitter's account email when none are listed.
async function recipients(app: App, submitterId: string): Promise<string[]> {
  const to = parseTags(app.contributorEmails);
  if (to.length > 0) return to;
  const fallback = await emailOfUser(submitterId);
  return fallback ? [fallback] : [];
}

async function mailLive(to: string[], app: App, pageTitle: string, pageUrl: string, what: string): Promise<void> {
  const name = esc(app.project.name);
  await send(
    to,
    `${app.project.name} is now live on ${pageTitle}`,
    layout({
      title: "Your app is live 🎉",
      body: `<b>${name}</b> is now visible on <b>${esc(pageTitle)}</b>. Share the page with your audience.`,
      cta: { url: pageUrl, label: `View ${app.project.name}` },
      footer: `You get this because you are listed as a contributor of <b>${name}</b> on Embarko Showcase.`,
    }),
    what
  );
}

// Contributors: the app was just placed on the public gallery (no review step).
export async function mailPublicListed(app: App, submitterId: string): Promise<void> {
  const to = await recipients(app, submitterId);
  await mailLive(to, app, "Embarko Showcase", `${FRONTEND_ORIGIN}/showcase`, `public mail for ${app.project.slug}`);
}

// Contributors (or the submitter when none are listed): approved or rejected.
export async function mailListingDecision(event: ShowcaseEvent, app: App, listing: ShowcaseEventListing): Promise<void> {
  const to = await recipients(app, listing.addedBy);
  const pageUrl = `${FRONTEND_ORIGIN}/showcase/${event.slug}`;
  const name = esc(app.project.name);
  const title = esc(event.title);

  if (listing.status === "approved") {
    await mailLive(to, app, event.title, pageUrl, `approved mail for ${app.project.slug} @ ${event.slug}`);
    return;
  }

  await send(
    to,
    `${app.project.name} was rejected from ${event.title}`,
    layout({
      title: "Your submission was rejected",
      body:
        `The organiser of <b>${title}</b> reviewed <b>${name}</b> and rejected it.` +
        (listing.rejectionReason ? `<br><br><b>Reason given:</b>${quote(listing.rejectionReason)}` : "") +
        `<br>You can address the feedback and submit the app again. It goes back into the review queue, ` +
        `or is approved at once if you submit with the page's code.`,
      footer: `You get this because you are listed as a contributor of <b>${name}</b> on Embarko Showcase.`,
    }),
    `rejected mail for ${app.project.slug} @ ${event.slug}`
  );
}
