import { logger } from "../lib/logger";
import { rememberCompany } from "./companyStore";
import { TtlCache } from "../lib/ttlCache";
import { createLagoCustomer, getLagoCustomer, subscribeToFreePlan, updateLagoCustomerName } from "../lib/lago";
import type { CreateLagoCustomerInput, LagoCustomer, LagoSubscription } from "../lib/lago";
import {
  createStripeCustomer,
  deleteStripeCustomer,
  updateStripeCustomerMetadata,
  updateStripeCustomerName,
} from "../lib/stripe";
import { prisma } from "../lib/prisma";

// Billing bootstrap for a company — three remote writes in order, with the
// Stripe customer rolled back if Lago refuses, so a failed attempt leaves
// nothing behind in the shared Stripe account and the caller can simply
// retry.
//
//   1. Stripe customer, tagged product/company_id (see billingUtility.ts)
//   2. Lago customer pointing at it (provider_customer_id)
//   3. Stripe metadata gets lago_customer_id, so both sides cross-reference
//   4. free-plan subscription
//
// Steps 3 and 4 run after the point of no return (Lago customer exists).
// 3 failing is cosmetic and only logged. 4 failing surfaces to the caller;
// a retry then hits the caller's 409 (customer exists) and the subscription
// has to be fixed in Lago — same behaviour as before this flow existed.
export async function setUpBillingForCompany(
  companyId: string,
  input: CreateLagoCustomerInput
): Promise<{ customer: LagoCustomer; subscription: LagoSubscription }> {
  const stripeCustomerId = await createStripeCustomer({
    companyId,
    name: input.name,
    email: input.email,
  });

  let customer: LagoCustomer;
  try {
    customer = await createLagoCustomer(companyId, input, stripeCustomerId);
  } catch (err) {
    await deleteStripeCustomer(stripeCustomerId).catch((rollbackErr) => {
      // Now there IS an orphan; log loudly with the id so it can be removed.
      logger.error(
        `[billing] Lago customer create failed for company ${companyId} AND rollback of Stripe customer ${stripeCustomerId} failed:`,
        rollbackErr
      );
    });
    throw err;
  }

  await updateStripeCustomerMetadata(stripeCustomerId, { lago_customer_id: customer.lago_id }).catch(
    (err) => {
      logger.warn(
        `[billing] could not set lago_customer_id on Stripe customer ${stripeCustomerId}:`,
        err
      );
    }
  );

  await rememberCompany(companyId, { lagoCustomerId: customer.lago_id, stripeCustomerId });
  const subscription = await subscribeToFreePlan(companyId);
  return { customer, subscription };
}

export type BillingReadiness = "ready" | "pending";

// Companies known to have a Lago customer. Only positive answers are cached
// (a customer is never deleted from this API), so ensureBillingForCompany
// costs nothing on repeat logins yet still repairs a company the moment it
// is actually missing.
const BILLING_READY_TTL_MS = 24 * 60 * 60 * 1000;
const billingReady = new TtlCache<boolean>("billingReady", BILLING_READY_TTL_MS);

// Idempotent, best-effort "make sure this company has billing". Used
// wherever a company may be seen for the first time WITHOUT having gone
// through POST /companies — chiefly login, because proxy creates a default
// company itself for a user who isn't in any yet, and that company never
// passes through this API otherwise. Also the POST /companies path.
//
// Never throws: a Stripe/Lago outage must not break login or company
// creation. Returns "pending" instead, and the caller/dashboard falls back
// to POST /companies/:companyId/billing/customer (docs/billing.md).
export async function ensureBillingForCompany(
  companyId: string,
  input: { name: string; email: string | null }
): Promise<BillingReadiness> {
  try {
    if (await billingReady.get(companyId)) return "ready";

    if (await getLagoCustomer(companyId)) {
      await billingReady.getOrLoad(companyId, async () => true);
      return "ready";
    }

    // Lago requires an email; without one there's nothing to do but wait for
    // the explicit endpoint, which validates one in.
    if (!input.email) {
      logger.warn(`[billing] no email for company ${companyId}; billing setup deferred`);
      return "pending";
    }

    await setUpBillingForCompany(companyId, { name: input.name, email: input.email });
    await billingReady.getOrLoad(companyId, async () => true);
    return "ready";
  } catch (err) {
    logger.error(`[billing] ensureBillingForCompany failed for ${companyId}:`, err);
    return "pending";
  }
}

// After a rename on proxy: keep the names on invoices in step. Best effort —
// proxy already has the new name, so a billing hiccup must not fail the
// rename. Companies with no billing yet pick the name up at setup.
export async function syncBillingCustomerName(companyId: string, name: string): Promise<void> {
  const row = await prisma.company
    .findUnique({ where: { id: companyId }, select: { lagoCustomerId: true, stripeCustomerId: true } })
    .catch(() => null);
  if (!row) return;
  await Promise.all([
    row.lagoCustomerId ? updateLagoCustomerName(companyId, name) : null,
    row.stripeCustomerId ? updateStripeCustomerName(row.stripeCustomerId, name) : null,
  ]).catch((err) => logger.warn(`[billing] could not sync name for company ${companyId}:`, err));
}
