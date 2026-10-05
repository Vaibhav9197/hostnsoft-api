// Client for Lago (getlago.com), which owns plans, customers and
// subscriptions for billing. See src/lib/billingUtility.ts for the split of
// responsibilities between Lago and Stripe.
//
// Auth is a single account-wide API key: server-side only, never logged.
// Every request here is made on the server's behalf; company scoping is
// enforced upstream by loadCompanyContext, and the company id is what we
// use as Lago's external_id (see lagoCustomerExternalId).

import { logger } from "./logger";
import {
  LAGO_API_URL,
  FREE_PLAN_CODE,
  PUBLIC_PLAN_CODES,
  isPublicPlan,
  billingErrors,
  lagoCustomerExternalId,
  lagoSubscriptionExternalId,
  LAGO_PAYMENT_PROVIDER,
  LAGO_PAYMENT_PROVIDER_CODE,
} from "./billingUtility";

if (!process.env.LAGO_API_KEY) {
  throw new Error("LAGO_API_KEY environment variable is not set.");
}
const LAGO_API_KEY: string = process.env.LAGO_API_KEY;

// Lago error bodies: { status, error, code?, error_details? }.
interface LagoErrorBody {
  status?: number;
  error?: string;
  code?: string;
  error_details?: unknown;
}

async function lagoRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${LAGO_API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LAGO_API_KEY}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw billingErrors.unavailable("lago", `unreachable: ${(err as Error)?.message}`);
  }

  if (response.status >= 500) {
    throw billingErrors.unavailable("lago", `returned ${response.status} on ${path}`);
  }
  if (response.status === 401 || response.status === 403) {
    logger.error(`[lago] API key rejected on ${path} (${response.status})`);
    throw billingErrors.unavailable("lago", "rejected the server's API key");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as LagoErrorBody;
    const detail = body.code ?? body.error ?? "unknown";
    if (response.status === 404) throw new LagoNotFound(`${path}: ${detail}`);
    if (response.status === 422) throw new LagoUnprocessable(`${path}: ${detail}`, body.error_details);
    throw billingErrors.rejected("lago", `returned ${response.status} on ${path}: ${detail}`);
  }

  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw billingErrors.rejected("lago", `returned a non-JSON body on ${path}`);
  }
}

// Internal signals so callers can branch on "not found" / "validation
// failed" without inspecting messages; anything that escapes a route is
// translated by the caller into a BillingError.
export class LagoNotFound extends Error { }
class LagoUnprocessable extends Error {
  constructor(message: string, public readonly details: unknown) {
    super(message);
  }
}

// ---- Customers -----------------------------------------------------------

export interface LagoBillingConfiguration {
  invoice_grace_period?: number;
  payment_provider?: "stripe" | "gocardless" | "adyen" | null;
  payment_provider_code?: string | null;
  // Stripe customer id once Lago has created/linked it.
  provider_customer_id?: string | null;
  sync?: boolean;
  sync_with_provider?: boolean;
  document_locale?: string;
  provider_payment_methods?: string[];
}

export interface LagoCustomer {
  lago_id: string;
  external_id: string;
  name?: string | null;
  email?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
  country?: string | null;
  legal_name?: string | null;
  tax_identification_number?: string | null;
  currency?: string | null;
  timezone?: string | null;
  billing_configuration?: LagoBillingConfiguration;
  created_at?: string;
  [key: string]: unknown;
}

export interface CreateLagoCustomerInput {
  name: string;
  email: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  country?: string;
  legal_name?: string;
  tax_identification_number?: string;
  currency?: string;
  timezone?: string;
}

// Lago returns 200 (not 404) for GET on an unknown external_id in some
// versions and 404 in others; both are handled.
export async function getLagoCustomer(companyId: string): Promise<LagoCustomer | null> {
  try {
    const body = await lagoRequest<{ customer?: LagoCustomer }>(
      `/customers/${encodeURIComponent(lagoCustomerExternalId(companyId))}`
    );
    return body.customer ?? null;
  } catch (err) {
    if (err instanceof LagoNotFound) return null;
    throw err;
  }
}

// POST /customers is an upsert keyed on external_id in Lago. We want
// create-only semantics (a second call must not silently rewrite billing
// details), so existence is checked first and 409 raised by the caller.
//
// The Stripe customer already exists (created by us, with product
// metadata) and is passed in as provider_customer_id; sync_with_provider
// stays off so Lago doesn't create a second, untagged one. Lago metadata
// carries the company and Stripe ids so an invoice can be traced back
// without this service.
export async function createLagoCustomer(
  companyId: string,
  input: CreateLagoCustomerInput,
  stripeCustomerId: string
): Promise<LagoCustomer> {
  const body = await lagoRequest<{ customer?: LagoCustomer }>(`/customers`, {
    method: "POST",
    body: JSON.stringify({
      customer: {
        external_id: lagoCustomerExternalId(companyId),
        ...input,
        billing_configuration: {
          payment_provider: LAGO_PAYMENT_PROVIDER,
          payment_provider_code: LAGO_PAYMENT_PROVIDER_CODE,
          provider_payment_methods: ["card"],
          provider_customer_id: stripeCustomerId,
          sync_with_provider: false,
        },
        metadata: [
          { key: "company_id", value: companyId, display_in_invoice: false },
          { key: "stripe_customer_id", value: stripeCustomerId, display_in_invoice: false },
        ],
      },
    }),
  }).catch((err) => {
    if (err instanceof LagoUnprocessable) {
      throw billingErrors.rejected("lago", `createCustomer validation failed: ${err.message}`);
    }
    throw err;
  });

  if (!body.customer) {
    throw billingErrors.rejected("lago", "did not return the created customer");
  }
  return body.customer;
}

// ---- Subscriptions -------------------------------------------------------

export interface LagoSubscription {
  lago_id: string;
  external_id: string;
  external_customer_id: string;
  plan_code: string;
  status: string;
  [key: string]: unknown;
}

// Creates OR changes the company's single subscription. Lago upserts on
// external_id: with no subscription it creates one; with an existing one
// on a different plan it performs an upgrade/downgrade in place (Lago
// decides immediate vs. end-of-period from the plans' pay_in_advance and
// the billing_time given). So this one call is customer bootstrap, change
// plan, and cancel-to-free — see the routes for which is which.
export async function assignPlan(companyId: string, planCode: string): Promise<LagoSubscription> {
  const body = await lagoRequest<{ subscription?: LagoSubscription }>(`/subscriptions`, {
    method: "POST",
    body: JSON.stringify({
      subscription: {
        external_customer_id: lagoCustomerExternalId(companyId),
        plan_code: planCode,
        external_id: lagoSubscriptionExternalId(companyId),
        billing_time: "anniversary",
      },
    }),
  }).catch((err) => {
    if (err instanceof LagoNotFound || err instanceof LagoUnprocessable) {
      throw billingErrors.rejected("lago", `assign plan ${planCode} failed: ${err.message}`);
    }
    throw err;
  });
  if (!body.subscription) {
    throw billingErrors.rejected("lago", "did not return the subscription");
  }
  return body.subscription;
}

export function subscribeToFreePlan(companyId: string): Promise<LagoSubscription> {
  return assignPlan(companyId, FREE_PLAN_CODE);
}

// The company's subscriptions that matter for "what am I on": `active`
// (current) and `pending` (a downgrade Lago has scheduled for the end of
// the current period). Terminated/canceled ones are history, not status.
// Normally one of each at most, given the single external_id.
export async function listSubscriptions(companyId: string): Promise<LagoSubscription[]> {
  const params = new URLSearchParams({
    external_customer_id: lagoCustomerExternalId(companyId),
    per_page: "100",
  });
  params.append("status[]", "active");
  params.append("status[]", "pending");
  const body = await lagoRequest<{ subscriptions?: LagoSubscription[] }>(`/subscriptions?${params}`);
  return body.subscriptions ?? [];
}

// The current (active) subscription, or null when the company has none.
export async function getActiveSubscription(companyId: string): Promise<LagoSubscription | null> {
  const subs = await listSubscriptions(companyId);
  return subs.find((s) => s.status === "active") ?? null;
}

// ---- Checkout ------------------------------------------------------------

// A Stripe-hosted page where the customer adds/updates a payment method
// (mode=setup — Lago never charges through it). Requires Lago to already
// have created the Stripe customer.
export async function getLagoCheckoutUrl(companyId: string): Promise<string> {
  const body = await lagoRequest<{ customer?: { checkout_url?: string } }>(
    `/customers/${encodeURIComponent(lagoCustomerExternalId(companyId))}/checkout_url`,
    { method: "POST" }
  ).catch((err) => {
    if (err instanceof LagoNotFound) throw billingErrors.noCustomer();
    if (err instanceof LagoUnprocessable) throw billingErrors.noStripeCustomer();
    throw err;
  });

  const url = body.customer?.checkout_url;
  if (!url) {
    throw billingErrors.rejected("lago", "did not return a checkout_url");
  }
  return url;
}

// ---- Plans ---------------------------------------------------------------

export interface LagoPlanCharge {
  lago_id: string;
  billable_metric_code?: string;
  charge_model?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LagoPlan {
  lago_id: string;
  name: string;
  code: string;
  description?: string | null;
  interval: string;
  amount_cents: number;
  amount_currency: string;
  trial_period?: number | null;
  pay_in_advance?: boolean;
  charges?: LagoPlanCharge[];
  [key: string]: unknown;
}

// One plan by code. Not restricted to PUBLIC_PLAN_CODES on purpose: a
// company may sit on a legacy/custom plan that the pricing page no longer
// lists, and the status endpoint still has to describe it.
export async function getLagoPlan(code: string): Promise<LagoPlan | null> {
  try {
    const body = await lagoRequest<{ plan?: LagoPlan }>(`/plans/${encodeURIComponent(code)}`);
    return body.plan ?? null;
  } catch (err) {
    if (err instanceof LagoNotFound) return null;
    throw err;
  }
}

// Only the plans whitelisted in PUBLIC_PLAN_CODES, in that list's order.
// Lago has no server-side filter by code, so the full catalogue is fetched
// (paged at 100 — more plans than that and the whitelist is the point) and
// filtered here.
export async function listLagoPlans(): Promise<LagoPlan[]> {
  const body = await lagoRequest<{ plans?: LagoPlan[] }>(`/plans?per_page=100&page=1`);
  const byCode = new Map((body.plans ?? []).filter((p) => isPublicPlan(p.code)).map((p) => [p.code, p]));
  return PUBLIC_PLAN_CODES.flatMap((code) => byCode.get(code) ?? []);
}
