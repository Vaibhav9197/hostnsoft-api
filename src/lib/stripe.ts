// Direct Stripe client. Creates the Stripe customer (tagged with product
// metadata — see billingUtility.ts) that Lago is then pointed at, and
// handles what Lago has no API for: listing and detaching saved payment
// methods. After creation the Stripe customer id is always read back from
// Lago (billing_configuration.provider_customer_id), never looked up here
// by metadata, so Lago stays the single source of truth for the link.
//
// STRIPE_SECRET_KEY is account-wide (shared with other products): server-
// side only, never logged. Plain fetch rather than the `stripe` SDK,
// matching src/lib/msg91.ts.

import { logger } from "./logger";
import { billingErrors, STRIPE_PRODUCT_TAG, stripeCustomerMetadata } from "./billingUtility";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY environment variable is not set.");
}
const STRIPE_SECRET_KEY: string = process.env.STRIPE_SECRET_KEY;
const STRIPE_API_URL = "https://api.stripe.com/v1";

interface StripeErrorBody {
  error?: { type?: string; code?: string; message?: string };
}

// Stripe takes application/x-www-form-urlencoded, with nested objects as
// bracketed keys: { metadata: { a: "1" } } -> metadata[a]=1.
function formEncode(params: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(params).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") return formEncode(value as Record<string, unknown>, name);
    return [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
  });
}

function formBody(params: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode(params).join("&"),
  };
}

async function stripeRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw billingErrors.unavailable("stripe", `unreachable: ${(err as Error)?.message}`);
  }

  if (response.status >= 500) {
    throw billingErrors.unavailable("stripe", `returned ${response.status} on ${path}`);
  }
  if (response.status === 401 || response.status === 403) {
    logger.error(`[stripe] secret key rejected on ${path} (${response.status})`);
    throw billingErrors.unavailable("stripe", "rejected the server's secret key");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as StripeErrorBody;
    const detail = body.error?.code ?? body.error?.message ?? "unknown";
    // resource_missing on the customer means Lago's provider_customer_id
    // points at a Stripe customer that no longer exists.
    if (response.status === 404 || body.error?.code === "resource_missing") {
      throw billingErrors.rejected("stripe", `customer not found on ${path}: ${detail}`);
    }
    throw billingErrors.rejected("stripe", `returned ${response.status} on ${path}: ${detail}`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw billingErrors.rejected("stripe", `returned a non-JSON body on ${path}`);
  }
}

// ---- Customers -----------------------------------------------------------

export interface CreateStripeCustomerInput {
  companyId: string;
  name: string;
  email: string;
}

// Metadata is set at creation, not patched in afterwards, so there is no
// window where an untagged customer sits in the shared account.
export async function createStripeCustomer(input: CreateStripeCustomerInput): Promise<string> {
  const customer = await stripeRequest<StripeCustomer>(
    `/customers`,
    formBody({
      name: input.name,
      email: input.email,
      description: `${STRIPE_PRODUCT_TAG} company ${input.companyId}`,
      metadata: stripeCustomerMetadata(input.companyId),
    })
  );
  return customer.id;
}

// Stripe merges metadata on update; only the given keys change.
export async function updateStripeCustomerMetadata(
  stripeCustomerId: string,
  metadata: Record<string, string>
): Promise<void> {
  await stripeRequest<StripeCustomer>(
    `/customers/${encodeURIComponent(stripeCustomerId)}`,
    formBody({ metadata })
  );
}

// Rollback only — used when the Lago half of customer creation fails so
// the shared account isn't left with an orphan customer.
export async function deleteStripeCustomer(stripeCustomerId: string): Promise<void> {
  await stripeRequest<{ deleted?: boolean }>(`/customers/${encodeURIComponent(stripeCustomerId)}`, {
    method: "DELETE",
  });
}

// ---- Payment methods -----------------------------------------------------

// Only the fields the dashboard needs to render a "saved cards" list.
// Everything else (fingerprints, billing_details.address, …) stays here.
export interface PaymentMethodSummary {
  id: string;
  type: string;
  isDefault: boolean;
  created: number;
  card?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    funding?: string;
    country?: string | null;
  };
  billingDetails: {
    name: string | null;
    email: string | null;
  };
}

interface StripePaymentMethod {
  id: string;
  type: string;
  created: number;
  customer?: string | null;
  card?: {
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
    funding?: string;
    country?: string | null;
  };
  billing_details?: { name?: string | null; email?: string | null };
}

interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

interface StripeCustomer {
  id: string;
  deleted?: boolean;
  invoice_settings?: { default_payment_method?: string | { id: string } | null };
}

// Two calls: the customer (for the default payment method) and the
// payment-method list. Stripe caps the list at 100 per page and a customer
// with more saved methods than that is not a case worth paging for.
export async function listStripePaymentMethods(
  stripeCustomerId: string
): Promise<PaymentMethodSummary[]> {
  const id = encodeURIComponent(stripeCustomerId);
  const [customer, methods] = await Promise.all([
    stripeRequest<StripeCustomer>(`/customers/${id}`),
    stripeRequest<StripeList<StripePaymentMethod>>(`/customers/${id}/payment_methods?limit=100`),
  ]);

  if (customer.deleted) {
    throw billingErrors.rejected("stripe", `customer ${stripeCustomerId} is deleted`);
  }

  const dpm = customer.invoice_settings?.default_payment_method;
  const defaultId = typeof dpm === "string" ? dpm : dpm?.id ?? null;

  return methods.data.map((pm) => ({
    id: pm.id,
    type: pm.type,
    isDefault: pm.id === defaultId,
    created: pm.created,
    ...(pm.card
      ? {
          card: {
            brand: pm.card.brand,
            last4: pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear: pm.card.exp_year,
            funding: pm.card.funding,
            country: pm.card.country ?? null,
          },
        }
      : {}),
    billingDetails: {
      name: pm.billing_details?.name ?? null,
      email: pm.billing_details?.email ?? null,
    },
  }));
}

// Detach (delete) a saved payment method. Ownership is checked first: a
// payment method id is global in Stripe, so without this any member of any
// company could detach any card in the account just by knowing its id. A
// card that belongs to someone else is reported as "not found", not
// "forbidden", so its existence isn't confirmed. Detaching the default
// payment method is allowed — Stripe clears the default, and Lago's next
// charge fails cleanly rather than silently.
export async function detachStripePaymentMethod(
  stripeCustomerId: string,
  paymentMethodId: string
): Promise<void> {
  const id = encodeURIComponent(paymentMethodId);

  let pm: StripePaymentMethod;
  try {
    pm = await stripeRequest<StripePaymentMethod>(`/payment_methods/${id}`);
  } catch (err) {
    // A bad/unknown id comes back from Stripe as resource_missing (mapped to
    // BILLING_REJECTED above); for the caller that is simply "not found".
    if ((err as { code?: string })?.code === "BILLING_REJECTED") {
      throw billingErrors.paymentMethodNotFound();
    }
    throw err;
  }
  if (pm.customer !== stripeCustomerId) {
    throw billingErrors.paymentMethodNotFound();
  }

  await stripeRequest<StripePaymentMethod>(`/payment_methods/${id}/detach`, { method: "POST" });
}
