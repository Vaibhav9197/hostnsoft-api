import { Router } from "express";
import { requireProxyToken } from "../middleware/proxyToken";
import { loadCompanyContext } from "../middleware/companyContext";
import { logAudit } from "../services/audit";
import { billingErrors, FREE_PLAN_CODE, isPublicPlan } from "../lib/billingUtility";
import {
  getLagoCustomer,
  getLagoCheckoutUrl,
  subscribeToFreePlan,
  assignPlan,
  listSubscriptions,
  getActiveSubscription,
  getLagoPlan,
} from "../lib/lago";
import { listStripePaymentMethods, detachStripePaymentMethod } from "../lib/stripe";
import { setUpBillingForCompany } from "../services/billingCustomer";
import { createCustomerSchema, changePlanSchema } from "../validation/billing.validation";
import { resyncCompanyFooters } from "../services/footerResync";

// Billing is per company (docs/billing.md). Lago holds one customer per
// company keyed by the proxy company id; Stripe is reached only through the
// Stripe customer id that Lago recorded. Nothing billing-related is stored
// locally, so every read here is a live call to Lago (and Stripe).

export const billingRouter = Router();

// The public plan catalogue (GET /billing/plans) lives in
// publicBilling.routes.ts, mounted before every requireProxyToken router.
// Everything in this router needs a token.
billingRouter.use(requireProxyToken);

// Creates the Stripe customer (product-tagged) and the Lago customer that
// points at it, then puts the company on the free plan — see
// services/billingCustomer.ts for ordering and rollback. POST /companies
// already does this on creation; this endpoint is the repair path for when
// that best-effort step failed (`billing: "pending"`) and for companies
// created through the proxy embed, which never pass through this API.
// Create-only: a second call is a 409 rather than an upsert, so billing
// details can't be overwritten from here by accident.
billingRouter.post(
  "/companies/:companyId/billing/customer",
  loadCompanyContext,
  async (req, res) => {
    const input = createCustomerSchema.parse(req.body);
    const companyId = req.company!.id;

    if (await getLagoCustomer(companyId)) {
      throw billingErrors.customerExists();
    }

    const { customer, subscription } = await setUpBillingForCompany(companyId, input);

    await logAudit({
      actorUserId: req.userId,
      companyId,
      action: "billing.customer.create",
      details: `lago_id=${customer.lago_id} stripe=${customer.billing_configuration?.provider_customer_id} plan=${subscription.plan_code}`,
    });

    res.status(201).json({ customer, subscription });
  }
);

billingRouter.get(
  "/companies/:companyId/billing/customer",
  loadCompanyContext,
  async (req, res) => {
    const customer = await getLagoCustomer(req.company!.id);
    if (!customer) throw billingErrors.noCustomer();
    res.json(customer);
  }
);

// Saved payment methods, straight from Stripe. Lago has no endpoint for
// this, so the Stripe customer id is read off the Lago customer first.
// Lago fills provider_customer_id asynchronously after creation; until
// then this is a 409 (BILLING_PROVIDER_NOT_LINKED), not an empty list, so
// the dashboard can tell "no cards yet" from "not ready yet".
billingRouter.get(
  "/companies/:companyId/billing/payment-methods",
  loadCompanyContext,
  async (req, res) => {
    const customer = await getLagoCustomer(req.company!.id);
    if (!customer) throw billingErrors.noCustomer();

    const stripeCustomerId = customer.billing_configuration?.provider_customer_id;
    if (!stripeCustomerId) throw billingErrors.noStripeCustomer();

    res.json(await listStripePaymentMethods(stripeCustomerId));
  }
);

// Delete (detach) a saved card. Ownership against the company's Stripe
// customer is enforced inside detachStripePaymentMethod.
billingRouter.delete(
  "/companies/:companyId/billing/payment-methods/:paymentMethodId",
  loadCompanyContext,
  async (req, res) => {
    const companyId = req.company!.id;
    const customer = await getLagoCustomer(companyId);
    if (!customer) throw billingErrors.noCustomer();

    const stripeCustomerId = customer.billing_configuration?.provider_customer_id;
    if (!stripeCustomerId) throw billingErrors.noStripeCustomer();

    await detachStripePaymentMethod(stripeCustomerId, req.params.paymentMethodId);

    await logAudit({
      actorUserId: req.userId,
      companyId,
      action: "billing.payment_method.delete",
      details: req.params.paymentMethodId,
    });

    res.status(204).end();
  }
);

// Stripe-hosted page (via Lago) for adding/updating a payment method. The
// URL is short-lived and single-use, so it's generated on every call and
// never cached or stored.
billingRouter.get(
  "/companies/:companyId/billing/checkout-url",
  loadCompanyContext,
  async (req, res) => {
    res.json({ checkoutUrl: await getLagoCheckoutUrl(req.company!.id) });
  }
);

// Billing status: the company's live subscriptions, each with its full plan
// attached. Lago's subscription object carries only plan_code (and a partial
// `plan` in some versions), so the plan is fetched separately — once per
// distinct code, in parallel. A `pending` entry alongside `active` means a
// downgrade is scheduled for the end of the current period. Customer
// details are deliberately not included; GET .../billing/customer has them.
// An empty list means billing isn't set up yet (or the free-plan step of
// customer creation failed) — no separate customer lookup for that.
billingRouter.get("/companies/:companyId/billing", loadCompanyContext, async (req, res) => {
  const subscriptions = await listSubscriptions(req.company!.id);

  const codes = [...new Set(subscriptions.map((s) => s.plan_code))];
  const plans = new Map(
    await Promise.all(codes.map(async (code) => [code, await getLagoPlan(code)] as const))
  );

  res.json({
    subscriptions: subscriptions.map((s) => ({ ...s, plan: plans.get(s.plan_code) ?? null })),
  });
});

// A paid plan needs a card on file, or Lago's first invoice just fails.
// The free plan never does — neither at customer bootstrap nor on cancel —
// which is why this lives here and not inside assignPlan. Checked against
// Stripe live (not cached), since the card is usually added moments earlier
// via checkout-url.
async function requirePaymentMethod(companyId: string): Promise<void> {
  const customer = await getLagoCustomer(companyId);
  if (!customer) throw billingErrors.noCustomer();

  const stripeCustomerId = customer.billing_configuration?.provider_customer_id;
  if (!stripeCustomerId) throw billingErrors.paymentMethodRequired();

  const methods = await listStripePaymentMethods(stripeCustomerId);
  if (methods.length === 0) throw billingErrors.paymentMethodRequired();
}

// Change plan. Only whitelisted (public) plans can be chosen from the API —
// anything else is a dashboard/Lago-console operation. Paid plans require a
// saved card (402 otherwise). Lago decides whether the switch is immediate
// (upgrade) or end-of-period (downgrade → a `pending` subscription appears
// in the status endpoint until then).
billingRouter.put(
  "/companies/:companyId/billing/subscription",
  loadCompanyContext,
  async (req, res) => {
    const { plan_code } = changePlanSchema.parse(req.body);
    const companyId = req.company!.id;

    if (!isPublicPlan(plan_code)) throw billingErrors.planNotAvailable(plan_code);

    const current = await getActiveSubscription(companyId);
    if (!current) throw billingErrors.noCustomer();
    if (current.plan_code === plan_code) throw billingErrors.alreadyOnPlan(plan_code);

    if (plan_code !== FREE_PLAN_CODE) await requirePaymentMethod(companyId);

    const subscription = await assignPlan(companyId, plan_code);

    await logAudit({
      actorUserId: req.userId,
      companyId,
      action: "billing.plan.change",
      details: `${current.plan_code} -> ${plan_code}`,
    });

    // Only free -> paid changes the footer right now: an upgrade is
    // immediate in Lago, so remove the footer now rather than on the next
    // deploy. Paid -> paid changes nothing; paid -> free is scheduled for
    // end-of-period and lands via the Lago webhook relayed through viaSocket
    // (internalBilling.routes.ts).
    if (current.plan_code === FREE_PLAN_CODE) {
      resyncCompanyFooters(companyId, `plan change ${current.plan_code} -> ${plan_code}`);
    }

    res.json(subscription);
  }
);

// Cancel = move to the free plan; the subscription itself is never
// terminated, so the company always has an active plan (and its usage
// keeps being metered against the free tier's limits). Being on free
// already is a 409, not a no-op, so the UI doesn't show "canceled" twice.
billingRouter.delete(
  "/companies/:companyId/billing/subscription",
  loadCompanyContext,
  async (req, res) => {
    const companyId = req.company!.id;

    const current = await getActiveSubscription(companyId);
    if (!current) throw billingErrors.noCustomer();
    if (current.plan_code === FREE_PLAN_CODE) throw billingErrors.alreadyOnPlan(FREE_PLAN_CODE);

    const subscription = await subscribeToFreePlan(companyId);

    await logAudit({
      actorUserId: req.userId,
      companyId,
      action: "billing.plan.cancel",
      details: `${current.plan_code} -> ${FREE_PLAN_CODE}`,
    });

    res.json(subscription);
  }
);
