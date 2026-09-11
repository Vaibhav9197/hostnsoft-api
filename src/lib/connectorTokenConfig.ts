/**
 * Config for the AI-connector token endpoints (src/routes/connectorAuth.routes.ts).
 * Same soft-override pattern as publicTokenConfig.ts. Both endpoints are
 * reachable without a proxy_auth_token header (the exchange endpoint takes
 * one in its body instead; validate takes only a deploy token), so both
 * get their own per-IP window, one keyPrefix each so a burst against one
 * never eats the other's budget.
 */
import { envNumber } from "./env";

export const CONNECTOR_TOKEN_RATE_WINDOW_MS: number = envNumber(
  "CONNECTOR_TOKEN_RATE_WINDOW_MS",
  60 * 60 * 1000
);
// Exchange requires a live proxy_auth_token already, so this just caps
// accidental/misbehaving-client retry storms, not credential guessing.
export const CONNECTOR_TOKEN_EXCHANGE_RATE_PER_IP: number = envNumber(
  "CONNECTOR_TOKEN_EXCHANGE_RATE_PER_IP",
  30
);
// Validate accepts only the token itself (a 256-bit secret — not
// guessable), but it's now open to the public internet rather than
// restricted to hostnsoft-deploy's host like /internal/deploy-tokens/validate,
// so it still gets a generous per-IP ceiling.
export const CONNECTOR_TOKEN_VALIDATE_RATE_PER_IP: number = envNumber(
  "CONNECTOR_TOKEN_VALIDATE_RATE_PER_IP",
  120
);
