import { logger } from "../lib/logger";
import { createLagoCustomer, subscribeToFreePlan } from "../lib/lago";
import type { CreateLagoCustomerInput, LagoCustomer, LagoSubscription } from "../lib/lago";
import {
  createStripeCustomer,
  deleteStripeCustomer,
  updateStripeCustomerMetadata,
} from "../lib/stripe";

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

  const subscription = await subscribeToFreePlan(companyId);
  return { customer, subscription };
}
