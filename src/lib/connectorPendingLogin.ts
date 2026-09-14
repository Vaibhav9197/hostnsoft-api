// Single-use, short-TTL opaque codes standing in for a proxy_auth_token
// during the connector redirect hop (see auth.routes.ts's GET
// /auth/msg91/callback and connectorAuth.routes.ts's POST /connector/token).
//
// The PAT itself must never appear in a redirect URL: URLs land in browser
// history and very commonly in the *receiving* service's own access logs,
// and the PAT is the same long-lived credential used for every dashboard
// API call - not something scoped to this one handoff. So instead of
// forwarding it directly, we mint a random opaque code, store the real PAT
// against it in Redis (shared across processes, matching every other
// cross-process lookup in this codebase - see ttlCache.ts) for a couple of
// minutes, and forward that. Redemption uses a MULTI GET+DEL (GETDEL isn't
// available on every Redis-compatible deployment we run against) to make
// redemption single-use: the second attempt to use the same code - a
// replayed URL from browser history or a log - always fails. MULTI/EXEC
// is atomic, so two concurrent redemptions still can't both see the value.
import crypto from "crypto";
import { redis } from "./redis";
import { logger } from "./logger";

const KEY_PREFIX = "hostnsoft-api:connector-pending-login:";
const TTL_MS = 2 * 60 * 1000;

function key(code: string): string {
  return `${KEY_PREFIX}${code}`;
}

export async function createPendingLoginCode(proxyAuthToken: string): Promise<string> {
  const code = crypto.randomBytes(32).toString("base64url");
  await redis.set(key(code), proxyAuthToken, { PX: TTL_MS });
  return code;
}

// Single-use: returns the PAT the first time, null on any later attempt
// (already redeemed, expired, or never issued) - callers should treat all
// three identically, as an invalid/expired grant.
export async function redeemPendingLoginCode(code: string): Promise<string | null> {
  const k = key(code);
  const value = await redis
    .multi()
    .get(k)
    .del(k)
    .exec()
    .then((results) => results?.[0] as string | null)
    .catch((err) => {
      logger.error("[connectorPendingLogin] redeem failed:", err);
      return null;
    });
  return value ?? null;
}
