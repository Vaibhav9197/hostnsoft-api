/**
 * Config for the public feature-request/feedback endpoint — see
 * docs/request-feature-req.md. Own rolling window, separate from
 * PUBLIC_TOKEN_RATE_* (src/lib/publicTokenConfig.ts) on purpose: a burst
 * of feedback shouldn't threaten someone's ability to request a deploy
 * token, or vice versa.
 */
import { envNumber } from "./env";

export const FEATURE_REQUEST_RATE_WINDOW_MS: number = envNumber(
  "FEATURE_REQUEST_RATE_WINDOW_MS",
  60 * 60 * 1000
);
export const FEATURE_REQUEST_RATE_PER_EMAIL: number = envNumber("FEATURE_REQUEST_RATE_PER_EMAIL", 10);
export const FEATURE_REQUEST_RATE_PER_IP: number = envNumber("FEATURE_REQUEST_RATE_PER_IP", 20);
export const FEATURE_REQUEST_RATE_GLOBAL: number = envNumber("FEATURE_REQUEST_RATE_GLOBAL", 500);
