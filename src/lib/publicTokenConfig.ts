/**
 * Config for the public email-based deploy-token endpoint — see
 * docs/plans/2026-09-08-001-feat-email-deploy-token-api-plan.md. Tunables
 * with sensible defaults (same soft-override pattern as orphanConfig.ts);
 * the outbound webhook URL lives in webhooks.ts and fails fast instead.
 */

import { envNumber } from "./env";

// Rolling-window limits for POST /public/deploy-tokens/request. All three
// are checked before any proxy/billing/email call. A rejected request still
// counts toward the window.
export const PUBLIC_TOKEN_RATE_WINDOW_MS: number = envNumber(
  "PUBLIC_TOKEN_RATE_WINDOW_MS",
  60 * 60 * 1000
);
export const PUBLIC_TOKEN_RATE_PER_EMAIL: number = envNumber("PUBLIC_TOKEN_RATE_PER_EMAIL", 5);
export const PUBLIC_TOKEN_RATE_PER_IP: number = envNumber("PUBLIC_TOKEN_RATE_PER_IP", 10);
// Protects the MSG91 email quota. Size to the plan.
export const PUBLIC_TOKEN_RATE_GLOBAL: number = envNumber("PUBLIC_TOKEN_RATE_GLOBAL", 200);

// Express `trust proxy` hop count. 0 (default) = off: when this API is not
// behind a reverse proxy, req.ip is the socket address and must not be
// overridable via X-Forwarded-For. Set to the number of proxies in front
// (usually 1) when deployed behind one so per-IP limits see the real client.
export const TRUST_PROXY: number = envNumber("TRUST_PROXY", 0);

// Where this API is reachable by agents — used only to print the public
// endpoint's URL inside deploy guidance messages. Defaults to the
// hostnsoft-api URL derived from nothing better than localhost.
export const API_PUBLIC_URL: string = (process.env.API_PUBLIC_URL ?? "http://localhost:4100").replace(
  /\/+$/,
  ""
);
