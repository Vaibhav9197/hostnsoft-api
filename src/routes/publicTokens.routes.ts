import { Router, type Request, type Response } from "express";
import { z } from "zod";
import rateLimit, { type Options as RateLimitOptions } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis, connectRedis } from "../lib/redis";
import {
  PUBLIC_TOKEN_RATE_GLOBAL,
  PUBLIC_TOKEN_RATE_PER_EMAIL,
  PUBLIC_TOKEN_RATE_PER_IP,
  PUBLIC_TOKEN_RATE_WINDOW_MS,
} from "../lib/publicTokenConfig";
import { handlePublicTokenRequest, normaliseEmail } from "../services/publicTokenRequest";

export const publicTokensRouter = Router();

const requestSchema = z.object({ email: z.string().trim().email().max(254) });

// The one response body every accepted request gets, whatever happened
// behind it (see publicTokenRequest.ts). Do not vary it.
export const PUBLIC_TOKEN_ACCEPTED_MESSAGE =
  "If this email address is valid, a deploy token for each of your companies has been sent to it. " +
  "Check the inbox (and spam folder). Each request creates a new token; your existing tokens keep working.";

// Three independent windows (email, IP, global), each its own counter in
// Redis so limits are shared across processes. A rejected request still
// counts. A Redis failure surfaces as a 500 from the store rather than
// letting requests through — this guards an unauthenticated endpoint.
type LimitScope = "email" | "ip" | "global";

const SCOPE_DESCRIPTION: Record<LimitScope, string> = {
  email: "this email address",
  ip: "your IP address",
  global: "the service as a whole",
};

function limiter(scope: LimitScope, limit: number, keyGenerator: (req: Request) => string) {
  const options: Partial<RateLimitOptions> = {
    windowMs: PUBLIC_TOKEN_RATE_WINDOW_MS,
    limit,
    keyGenerator,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    store: new RedisStore({
      prefix: `hostnsoft-api:ratelimit:public-token:${scope}:`,
      // The store loads its Lua scripts in its constructor, i.e. at module
      // import — before server.ts has connected Redis. Wait for the
      // connection instead of sending into a closed client.
      sendCommand: async (...args: string[]) => {
        await connectRedis();
        return redis.sendCommand(args);
      },
    }),
    handler: (req: Request, res: Response) => {
      const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(((resetTime?.getTime() ?? Date.now()) - Date.now()) / 1000)
      );
      const windowMinutes = Math.round(PUBLIC_TOKEN_RATE_WINDOW_MS / 60_000);
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error:
          `Too many token requests for ${SCOPE_DESCRIPTION[scope]}: ` +
          `limit is ${limit} per ${windowMinutes} minutes. Try again in ${retryAfterSeconds} seconds.`,
        code: "RATE_LIMITED",
        scope,
        limit,
        windowMinutes,
        retryAfterSeconds,
      });
    },
  };
  return rateLimit(options);
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
