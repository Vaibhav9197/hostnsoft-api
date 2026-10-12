// Constants and the shared error type for billing (Lago + Stripe).
//
// Lago is the source of truth for plans, customers and subscriptions. The
// Stripe customer is created by US (not by Lago's sync_with_provider) so it
// carries product metadata from the first second — the Stripe account is
// shared with other products, and every customer in it must say which
// product it belongs to. Its id is then handed to Lago as
// provider_customer_id. See src/services/billingCustomer.ts for the
// create flow and src/lib/lago.ts / src/lib/stripe.ts for the clients.
//
// The Lago API URL and free-plan code are code constants, not env vars:
// they change together with the code that depends on them (a plan code is
// referenced by name below), so keeping them here avoids an env mismatch
// silently pointing at the wrong plan.

export const LAGO_API_URL = "https://api.billing.gtwy.ai/api/v1";
export const LAGO_PAYMENT_PROVIDER = 'stripe';
export const LAGO_PAYMENT_PROVIDER_CODE = process.env.NODE_ENV === 'production' ? 'superheros' : 'stripe_dev';

// Tags every Stripe customer this service creates, so they can be told
// apart from other products' customers in the shared Stripe account
// (Stripe search: `metadata['product']:'embarko'`). Other products use a
// bare `customer_id` key; we add `product` because ids alone are ambiguous
// across products.
export const STRIPE_PRODUCT_TAG = "embarko";

export function stripeCustomerMetadata(companyId: string): Record<string, string> {
  return { product: STRIPE_PRODUCT_TAG, embarko_company_id: companyId };
}

// Every new customer is subscribed to this plan at creation so a company
// always has an active subscription. The plan must exist in Lago with this
// exact code.
export const FREE_PLAN_CODE = "embarko_free";

// The Lago org holds many plans (legacy, custom, internal); only these are
// shown on the pricing UI. GET /billing/plans returns them in THIS order,
// so the array doubles as the display order. Codes must match Lago exactly.
// A code listed here but missing in Lago is silently absent from the
// response — check the Lago dashboard, not this list, if a plan vanishes.
export const PUBLIC_PLAN_CODES: readonly string[] = [
  FREE_PLAN_CODE,
  "embarko_creator",
  "embarko_creator_annual",
  "embarko_team",
  "embarko_team_annual"
];

export function isPublicPlan(code: string): boolean {
  return PUBLIC_PLAN_CODES.includes(code);
}

// One customer per company: the Lago external_id IS the proxy company id,
// which is also what the URL carries, so lookups need no local mapping
// table.
export function lagoCustomerExternalId(companyId: string): string {
  return companyId;
}

// One subscription per company, too: a company is on exactly one plan at a
// time and plan changes upgrade/downgrade that subscription in place rather
// than creating another. So the subscription's external_id is also the
// company id — every call that touches "the company's subscription"
// (create, change plan, terminate) must derive it from here, never inline.
export function lagoSubscriptionExternalId(companyId: string): string {
  return companyId;
}

// Mirrors ProxyError (src/lib/msg91.ts): carries a client-safe status and
// message so errorHandler answers for it and routes need no try/catch.
export class BillingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly code?: string,
    // Optional machine-readable extra (e.g. { reason }) that errorHandler
    // includes in the JSON body when present.
    public readonly details?: unknown
  ) {
    super(message);
  }
}

// Why Lago refused to apply a coupon, as a fixed enum. The raw Lago code is
// logged, never returned.
export type CouponRejectReason =
  | "not_reusable"
  | "already_applied"
  | "already_used"
  | "plan_overlap"
  | "currency_mismatch"
  | "terminated"
  | "expired"
  | "pending_free_downgrade"
  | "other";

export const billingErrors = {
  // Lago/Stripe unreachable, timed out, 5xx, or rejected OUR key.
  unavailable: (provider: "lago" | "stripe", message: string) =>
    new BillingError(
      `${provider}: ${message}`,
      503,
      "Billing service unavailable",
      "BILLING_UNAVAILABLE"
    ),
  // Provider answered with a 4xx we can't map to a caller mistake.
  rejected: (provider: "lago" | "stripe", message: string) =>
    new BillingError(
      `${provider}: ${message}`,
      502,
      "Billing service rejected the request",
      "BILLING_REJECTED"
    ),
  noCustomer: () =>
    new BillingError(
      "no Lago customer for this company",
      404,
      "Billing is not set up for this company",
      "BILLING_CUSTOMER_NOT_FOUND"
    ),
  customerExists: () =>
    new BillingError(
      "Lago customer already exists for this company",
      409,
      "Billing is already set up for this company",
      "BILLING_CUSTOMER_EXISTS"
    ),
  planNotAvailable: (code: string) =>
    new BillingError(
      `plan ${code} is not in PUBLIC_PLAN_CODES`,
      400,
      "That plan is not available",
      "BILLING_PLAN_NOT_AVAILABLE"
    ),
  alreadyOnPlan: (code: string) =>
    new BillingError(
      `company is already on plan ${code}`,
      409,
      "The company is already on that plan",
      "BILLING_ALREADY_ON_PLAN"
    ),
  // 402 Payment Required: the caller must add a card (checkout-url) first.
  paymentMethodRequired: () =>
    new BillingError(
      "no payment method on the Stripe customer; paid plan refused",
      402,
      "Add a payment method before choosing a paid plan",
      "BILLING_PAYMENT_METHOD_REQUIRED"
    ),
  paymentMethodNotFound: () =>
    new BillingError(
      "payment method not found or not owned by this company's Stripe customer",
      404,
      "Payment method not found",
      "BILLING_PAYMENT_METHOD_NOT_FOUND"
    ),
  couponNotFound: () =>
    new BillingError("coupon code unknown", 404, "Coupon code not found", "BILLING_COUPON_NOT_FOUND"),
  couponNotApplicable: (reason: CouponRejectReason, detail?: string) =>
    new BillingError(
      `coupon not applicable: ${reason}${detail ? ` (${detail})` : ""}`,
      422,
      "This coupon can't be applied",
      "BILLING_COUPON_NOT_APPLICABLE",
      { reason }
    ),
  couponRequiresPaidPlan: () =>
    new BillingError(
      "coupon apply refused: company is (or will be) on the free plan",
      409,
      "Coupons can only be applied on a paid plan. Apply it when you upgrade.",
      "BILLING_COUPON_REQUIRES_PAID_PLAN"
    ),
  noStripeCustomer: () =>
    new BillingError(
      "Lago customer has no provider_customer_id yet",
      409,
      "Payment provider customer is not linked yet",
      "BILLING_PROVIDER_NOT_LINKED"
    ),
};
