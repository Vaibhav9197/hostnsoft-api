import { Router, type Request } from "express";
import { z } from "zod";
import {
  FEATURE_REQUEST_RATE_GLOBAL,
  FEATURE_REQUEST_RATE_PER_EMAIL,
  FEATURE_REQUEST_RATE_PER_IP,
  FEATURE_REQUEST_RATE_WINDOW_MS,
} from "../lib/featureRequestConfig";
import { createLimiter, type LimitScope } from "../lib/rateLimit";
import { logger } from "../lib/logger";
import { Webhook, callWebhook } from "../lib/webhooks";
import { prisma } from "../lib/prisma";
import {
  createFeatureRequest,
  featureRequestMessageSchema,
  featureRequestTypeSchema,
} from "../services/featureRequests";

export const publicCustomerQueryRouter = Router();

// Path B (docs/request-feature-req.md) — anonymous visitor, no session at
// all. Same open+rate-limited shape as POST /public/deploy-tokens/request
// (publicTokens.routes.ts), own Redis counters (see
// lib/featureRequestConfig.ts) — a burst of feedback shouldn't threaten
// someone's ability to request a deploy token, or vice versa. Mounted
// before every requireProxyToken router — see routes/index.ts.
//
// Renamed from /feature-requests to /customer-query (2026-09-09) — see
// customerQuery.routes.ts.
const publicSchema = z.object({
  type: featureRequestTypeSchema,
  message: featureRequestMessageSchema,
  email: z.string().trim().email().max(254),
  // "Contact Dev" (panel: app/api/showcase/contact): the visitor's name, the
  // app, and the developer to mail. toEmail must be that app's contactEmail —
  // the API never mails an arbitrary address.
  name: z.string().trim().max(120).optional(),
  appSlug: z.string().trim().max(63).optional(),
  toEmail: z.string().trim().toLowerCase().email().max(254).optional(),
});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Mails the developer. Returns false when toEmail isn't the app's own
// contactEmail (nothing is sent) — the caller answers 404 like a missing app.
async function mailDeveloper(body: z.infer<typeof publicSchema>): Promise<boolean> {
  const app = body.appSlug
    ? await prisma.appDetails.findFirst({ where: { project: { slug: body.appSlug } }, select: { name: true, contactEmail: true } })
    : null;
  if (!app?.contactEmail || app.contactEmail !== body.toEmail) return false;

  const from = body.name ? `${escapeHtml(body.name)} (${escapeHtml(body.email)})` : escapeHtml(body.email);
  await callWebhook(Webhook.SHOWCASE_CONTACT_EMAIL, {
    to: [{ email: app.contactEmail }],
    subject: `${body.name || body.email} wants to contact you about ${app.name}`,
    variables: {
      content:
        `<p><b>${from}</b> sent you a message about <b>${escapeHtml(app.name)}</b> on Embarko Showcase:</p>` +
        `<p style="white-space:pre-wrap">${escapeHtml(body.message)}</p>` +
        `<p style="color:#888;font-size:12px">Reply to <a href="mailto:${escapeHtml(body.email)}">${escapeHtml(body.email)}</a> to answer. ` +
        `You get these because your app lists a contact email on Embarko Showcase.</p>`,
    },
  });
  return true;
}

function limiter(scope: LimitScope, limit: number, keyGenerator: (req: Request) => string) {
  return createLimiter(
    "feature-request",
    "feature requests",
    scope,
    limit,
    FEATURE_REQUEST_RATE_WINDOW_MS,
    keyGenerator
  );
}

// The per-email limiter needs a stable key even for a request whose body
// won't survive Zod validation later — falls back to IP rather than
// rejecting here, so a malformed body still gets a clean 400 from the
// handler below instead of a confusing 429.
function emailOrIp(req: Request): string {
  const email = req.body?.email;
  return typeof email === "string" ? email.trim().toLowerCase() : (req.ip ?? "unknown");
}

publicCustomerQueryRouter.post(
  "/public/customer-query",
  limiter("email", FEATURE_REQUEST_RATE_PER_EMAIL, emailOrIp),
  limiter("ip", FEATURE_REQUEST_RATE_PER_IP, (req) => req.ip ?? "unknown"),
  limiter("global", FEATURE_REQUEST_RATE_GLOBAL, () => "all"),
  async (req, res) => {
    const body = publicSchema.parse(req.body);

    if (body.toEmail) {
      try {
        if (!(await mailDeveloper(body))) {
          return res.status(404).json({ error: "This developer can't be contacted", code: "SHOWCASE_NO_CONTACT" });
        }
      } catch (err) {
        logger.error(`[customerQuery] contact-dev mail for ${body.appSlug} failed:`, err);
        return res.status(502).json({ error: "Couldn't send the message right now. Try again shortly." });
      }
    }

    const featureRequest = await createFeatureRequest({
      type: body.type,
      message: body.message,
      email: body.email.trim().toLowerCase(),
      source: "public",
      projectSlug: body.appSlug ?? null,
    });
    res.status(201).json({ id: featureRequest.id });
  }
);
