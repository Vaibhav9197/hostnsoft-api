import { Router } from "express";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";

export const healthRouter = Router();

// Each dependency gets this long before it counts as down. Prisma waits
// ~10s for a pool connection by default, longer than an uptime monitor
// waits for the whole response.
const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function check(name: string, run: () => Promise<unknown>): Promise<"ok" | "down"> {
  try {
    await withTimeout(run(), CHECK_TIMEOUT_MS);
    return "ok";
  } catch (err) {
    // Only failures are logged: at one check a minute, logging every
    // success would add ~1440 lines a day.
    logger.error(`[health] ${name} check failed:`, (err as Error)?.message ?? err);
    return "down";
  }
}

// Read by deploy-service's own /health (this service is never exposed
// through Traefik), which an external uptime monitor polls. 503 when any
// dependency is down, so the monitor alerts on the status code alone.
// The body names what failed, never why: the reason is in the log.
healthRouter.get("/health", async (_req, res) => {
  const [db, cache] = await Promise.all([
    check("db", () => prisma.$queryRaw`SELECT 1`),
    check("redis", () => redis.ping()),
  ]);
  const ok = db === "ok" && cache === "ok";
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "down", db, redis: cache });
});
