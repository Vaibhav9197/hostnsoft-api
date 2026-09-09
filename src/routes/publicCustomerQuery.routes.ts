import { Router, type Request } from "express";
import { z } from "zod";
import {
  FEATURE_REQUEST_RATE_GLOBAL,
  FEATURE_REQUEST_RATE_PER_EMAIL,
  FEATURE_REQUEST_RATE_PER_IP,
  FEATURE_REQUEST_RATE_WINDOW_MS,
} from "../lib/featureRequestConfig";
import { createLimiter, type LimitScope } from "../lib/rateLimit";
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
});

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
    const featureRequest = await createFeatureRequest({
      ...body,
      email: body.email.trim().toLowerCase(),
      source: "public",
    });
    res.status(201).json({ id: featureRequest.id });
  }
);
