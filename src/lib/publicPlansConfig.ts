// Rate limits for the open GET /billing/plans. Own window, separate from the
// other PUBLIC_*/FEATURE_* counters; looser, since it's a read not a write.
import { envNumber } from "./env";

export const PUBLIC_PLANS_RATE_WINDOW_MS: number = envNumber(
  "PUBLIC_PLANS_RATE_WINDOW_MS",
  60 * 60 * 1000
);
export const PUBLIC_PLANS_RATE_PER_IP: number = envNumber("PUBLIC_PLANS_RATE_PER_IP", 120);
export const PUBLIC_PLANS_RATE_GLOBAL: number = envNumber("PUBLIC_PLANS_RATE_GLOBAL", 10000);
