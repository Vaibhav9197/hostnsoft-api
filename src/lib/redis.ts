// Shared Redis client, used for caching proxy lookups (src/lib/msg91.ts).
// Required, not optional — a silent in-memory fallback would make the
// caching guarantees (shared across processes, positives-only TTLs)
// depend on which process handled the request.
import { createClient } from "redis";
import { logger } from "./logger";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL environment variable is not set.");
}

// No reconnect retries: a Redis outage should surface immediately (as a
// failed cache read/write -> 503 via errorHandler), not retry silently
// while every request pays the connection-error latency.
export const redis = createClient({
  url: process.env.REDIS_URL,
  socket: { reconnectStrategy: false },
});
redis.on("error", (err) => logger.error("[redis] connection error:", err.message ?? err));

let connecting: Promise<unknown> | null = null;
export function connectRedis() {
  if (!connecting) connecting = redis.connect();
  return connecting;
}
