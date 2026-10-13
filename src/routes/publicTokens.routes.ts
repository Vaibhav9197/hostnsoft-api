import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  PUBLIC_TOKEN_RATE_GLOBAL,
  PUBLIC_TOKEN_RATE_PER_EMAIL,
  PUBLIC_TOKEN_RATE_PER_IP,
  PUBLIC_TOKEN_RATE_WINDOW_MS,
} from "../lib/publicTokenConfig";
import { createLimiter, type LimitScope } from "../lib/rateLimit";
import { handlePublicTokenRequest, normaliseEmail } from "../services/publicTokenRequest";

export const publicTokensRouter = Router();

const requestSchema = z.object({ email: z.string().trim().email().max(254) });

// The one response body every accepted request gets, whatever happened
// behind it (see publicTokenRequest.ts). Do not vary it.
export const PUBLIC_TOKEN_ACCEPTED_MESSAGE =
  "If this email address is valid, a deploy token for each of your workspaces has been sent to it. " +
  "Check the inbox (and spam folder). Each request creates a new token; your existing tokens keep working.";

// Three independent windows (email, IP, global), each its own counter in
// Redis so limits are shared across processes. A rejected request still
// counts. A Redis failure surfaces as a 500 from the store rather than
// letting requests through — this guards an unauthenticated endpoint.
function limiter(scope: LimitScope, limit: number, keyGenerator: (req: Request) => string) {
  return createLimiter("public-token", "token requests", scope, limit, PUBLIC_TOKEN_RATE_WINDOW_MS, keyGenerator);
}

// Validate first so the per-email limiter keys on a real, normalised address
// (and a malformed body costs no counter).
function validateEmail(req: Request, _res: Response, next: () => void) {
  const { email } = requestSchema.parse(req.body);
  req.body.email = normaliseEmail(email);
  next();
}

// Open, unauthenticated by design: the inbox is the credential. Mounted
// before every requireProxyToken router (see routes/index.ts). Only two
// non-202 outcomes exist — 400 (bad email) and 429 (rate limited) — and
// both are decided before any external call.
publicTokensRouter.post(
  "/public/deploy-tokens/request",
  validateEmail,
  limiter("email", PUBLIC_TOKEN_RATE_PER_EMAIL, (req) => req.body.email),
  limiter("ip", PUBLIC_TOKEN_RATE_PER_IP, (req) => req.ip ?? "unknown"),
  limiter("global", PUBLIC_TOKEN_RATE_GLOBAL, () => "all"),
  async (req, res) => {
    await handlePublicTokenRequest(req.body.email);
    res.status(202).json({ message: PUBLIC_TOKEN_ACCEPTED_MESSAGE });
  }
);
