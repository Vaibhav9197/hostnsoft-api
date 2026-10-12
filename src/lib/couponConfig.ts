/**
 * Self-serve coupon config — see docs/billing.md "Coupons". Any Lago coupon
 * code can be redeemed from the panel; the rate limit is what keeps codes
 * from being guessed cheaply.
 */
import { envNumber } from "./env";

export const COUPON_RATE_WINDOW_MS: number = envNumber("COUPON_RATE_WINDOW_MS", 5 * 60 * 1000);
export const COUPON_RATE_PER_USER: number = envNumber("COUPON_RATE_PER_USER", 20);
export const COUPON_RATE_PER_COMPANY: number = envNumber("COUPON_RATE_PER_COMPANY", 60);
