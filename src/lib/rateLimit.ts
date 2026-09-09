// Shared rolling-window rate limiter for open, unauthenticated endpoints —
// extracted from the original POST /public/deploy-tokens/request limiter
// so a second public endpoint (feature requests) doesn't reimplement the
// same ~50 lines with a different Redis key prefix.
import rateLimit, { type Options as RateLimitOptions } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { Request, Response } from "express";
import { redis, connectRedis } from "./redis";

export type LimitScope = "email" | "ip" | "global";

const SCOPE_DESCRIPTION: Record<LimitScope, string> = {
  email: "this email address",
  ip: "your IP address",
  global: "the service as a whole",
};

// keyPrefix namespaces the Redis counters per endpoint (e.g.
// "public-token", "feature-request") so a burst against one never eats
// into another's limit. requestLabel is just the plural noun used in the
// 429 message ("token requests", "feature requests").
export function createLimiter(
  keyPrefix: string,
  requestLabel: string,
  scope: LimitScope,
  limit: number,
  windowMs: number,
  keyGenerator: (req: Request) => string
) {
  const options: Partial<RateLimitOptions> = {
    windowMs,
    limit,
    keyGenerator,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    store: new RedisStore({
      prefix: `hostnsoft-api:ratelimit:${keyPrefix}:${scope}:`,
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
      const windowMinutes = Math.round(windowMs / 60_000);
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error:
          `Too many ${requestLabel} for ${SCOPE_DESCRIPTION[scope]}: ` +
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
