# API — Billing (Lago + Stripe)

> Handlers in [`src/routes/billing.routes.ts`](../src/routes/billing.routes.ts); request schemas in [`src/validation/billing.validation.ts`](../src/validation/billing.validation.ts).
> Clients: [`src/lib/lago.ts`](../src/lib/lago.ts), [`src/lib/stripe.ts`](../src/lib/stripe.ts).
> Constants / error type: [`src/lib/billingUtility.ts`](../src/lib/billingUtility.ts).

## Model

- **Lago** owns plans, customers and subscriptions. One Lago customer per
  company; its `external_id` **is** the proxy company id, so no local mapping
  table exists and nothing billing-related is stored in this DB.
- One **subscription** per company as well, with `external_id` also equal to
  the company id (`lagoSubscriptionExternalId`). Plan changes must
  upgrade/downgrade that subscription in place, never create a second one.
- The **Stripe customer is created by this service**, not by Lago. The
  Stripe account is shared with other products, so every customer must be
  tagged at creation: metadata `product = "embarko"`, `company_id`
  (`STRIPE_PRODUCT_TAG` / `stripeCustomerMetadata` in `billingUtility.ts`).
  Its id is passed to Lago as `provider_customer_id` with
  `sync_with_provider = false`; after Lago answers, `lago_customer_id` is
  added to the Stripe metadata. Lago's customer metadata carries
  `company_id` and `stripe_customer_id`. Flow and rollback:
  `src/services/billingCustomer.ts` — if Lago refuses, the Stripe customer
  is deleted so a retry starts clean.
- Beyond creation, **Stripe** is called directly only where Lago has no
  API: listing and detaching saved payment methods. The Stripe id is always
  read back from Lago, never searched by metadata.
- Every new customer is subscribed to `FREE_PLAN_CODE`
  (`billingUtility.ts`, currently `"free"`). That plan must exist in Lago.
- The Lago org has more plans than the UI shows. `PUBLIC_PLAN_CODES` in
  `billingUtility.ts` whitelists the visible ones and sets their order;
  edit that list to publish or hide a plan.

Env: `LAGO_API_KEY`, `STRIPE_SECRET_KEY` (both server-side only). The Lago
API URL (`LAGO_API_URL`) is a code constant — change it in `billingUtility.ts`
for the EU region or a self-hosted instance.

All routes require `proxy_auth_token`; company-scoped ones also require
membership (`loadCompanyContext`, non-members get 404).

## When the customer gets created

Three places, all through `ensureBillingForCompany`
(`src/services/billingCustomer.ts`), which is idempotent (Lago customer
exists → done, cached 24h in Redis), best effort (never throws; a
Stripe/Lago failure logs and yields `"pending"`) and skips when no email is
known:

1. **`POST /companies`** — right after the company exists on proxy. Email:
   the body's `email`, else the creator's. Response carries
   `billing: "ready" | "pending"`.
2. **Login** (`POST /auth/msg91/exchange`, `GET /auth/msg91/callback`) — for
   the identity's current company. This is what catches the default company
   **proxy itself creates** for a first-time user who isn't in any company,
   and companies made through the proxy embed; neither passes through
   `POST /companies`. Email: the user's. Exchange returns `billing`; the
   callback runs it fire-and-forget (it answers with a redirect).
3. **`POST /companies/:companyId/billing/customer`** — explicit, for
   `"pending"` or anything the above missed. 409 if already set up.

An empty list from `GET /companies/:companyId/billing` also means "call 3".

## Routes

| Route | Method | Description |
|---|---|---|
| `/billing/plans` | GET | **no auth**, rate-limited — public Lago plans only (`PUBLIC_PLAN_CODES` in `billingUtility.ts`, in that order) |
| `/companies/:companyId/billing/customer` | POST | set up billing explicitly (repair path; `POST /companies` does it automatically) |
| `/companies/:companyId/billing/customer` | GET | the company's Lago customer |
| `/companies/:companyId/billing/payment-methods` | GET | saved payment methods, direct from Stripe |
| `/companies/:companyId/billing/payment-methods/:paymentMethodId` | DELETE | detach a saved card (must belong to the company's Stripe customer) |
| `/companies/:companyId/billing/checkout-url` | GET | Stripe-hosted (via Lago) page to add/update a payment method |
| `/companies/:companyId/billing` | GET | status: live subscriptions, each with its full plan |
| `/companies/:companyId/billing/subscription` | PUT | change plan (`{ plan_code, coupon_code? }`, plan must be in `PUBLIC_PLAN_CODES`) |
| `/companies/:companyId/billing/coupons/:code` | GET | **check** a coupon without applying it (`?plan_code=` for an upgrade) |
| `/companies/:companyId/billing/coupons` | POST | apply a coupon on the current paid plan (`{ coupon_code }`) |
| `/companies/:companyId/billing/coupons` | GET | active applied coupons |
| `/companies/:companyId/billing/subscription` | DELETE | cancel = move to the free plan |

Every route above except `GET /billing/plans` requires `proxy_auth_token`.

That one is open for signed-out pricing pages. It stays public through two
orderings — keep both if you edit either file:

1. It's registered **above** `billingRouter.use(requireProxyToken)`.
2. `billingRouter` is mounted **above** the blanket-check routers in `routes/index.ts`.

It leaks nothing company-specific (`listLagoPlans` filters to
`PUBLIC_PLAN_CODES`) and is rate-limited per IP and globally
(`PUBLIC_PLANS_RATE_*`). The per-IP limit needs `trust proxy` set correctly
behind a load balancer, or every caller looks like one IP.

### POST /companies/:companyId/billing/customer
Body (all but `name`, `email` optional):
```ts
{
  name: string; email: string;
  address_line1?, address_line2?, city?, state?, zipcode?: string;
  country?: string;   // ISO 3166-1 alpha-2
  legal_name?, tax_identification_number?: string;
  currency?: string;  // ISO 4217; must match the plans' currency
  timezone?: string;
}
```
- 201 `{ customer, subscription }` (Lago objects as returned).
- 409 `BILLING_CUSTOMER_EXISTS` — create-only; Lago's own upsert semantics
  are deliberately not exposed so billing details can't be overwritten here.
- If Lago rejects the customer, the just-created Stripe customer is deleted
  and the error surfaces; retry is safe. If the free-plan subscription
  fails after both customers exist, they stay; a retry gets the 409 and the
  subscription must be fixed in Lago.

### GET /companies/:companyId/billing/payment-methods
- 200 `PaymentMethodSummary[]` — `{ id, type, isDefault, created, card?: { brand, last4, expMonth, expYear, funding, country }, billingDetails: { name, email } }`.
  `isDefault` is Stripe's `invoice_settings.default_payment_method`.
- 404 `BILLING_CUSTOMER_NOT_FOUND` — no Lago customer yet.
- 409 `BILLING_PROVIDER_NOT_LINKED` — the Lago customer has no
  `provider_customer_id`. Should not happen for customers created here (the
  id is set at creation); guards against ones created in the Lago console.

### DELETE /companies/:companyId/billing/payment-methods/:paymentMethodId
Detaches the card in Stripe. 204 on success. 404
`BILLING_PAYMENT_METHOD_NOT_FOUND` if the id is unknown **or** belongs to
another Stripe customer (existence is not confirmed to outsiders). Detaching
the default card is allowed; Stripe clears the default.

### GET /companies/:companyId/billing/checkout-url
- 200 `{ checkoutUrl }`. Short-lived, single-use; generated per call, never stored.
- 404 / 409 as above.

### GET /companies/:companyId/billing
```ts
{ subscriptions: (LagoSubscription & { plan: LagoPlan | null })[] }  // status active + pending
```
`status: "pending"` alongside an `active` one is a scheduled downgrade.
Plans are fetched by code (`GET /plans/:code`) because Lago's subscription
object carries only `plan_code`; `plan` is `null` if the code no longer
exists in Lago. Customer details are not included — use
`GET .../billing/customer`. An empty list means billing isn't set up.

### PUT /companies/:companyId/billing/subscription
Body `{ plan_code, coupon_code? }`. With a coupon: the coupon is checked and
applied **before** `assignPlan`. If its table row has `skip_payment_method`,
the 402 card check is skipped (decided server-side from the table; the
check endpoint's `skipPaymentMethod` is only a UI hint) (an immediate upgrade invoices on creation,
so a coupon applied afterwards would miss it). If `assignPlan` then fails the
applied coupon is deleted again, best effort, and the original error is
returned. A coupon on a move to the free plan is a 409
`BILLING_COUPON_REQUIRES_PAID_PLAN`. Lago upserts the company's single subscription
(`external_id` = company id) with the new plan: upgrades apply immediately,
downgrades at period end (a `pending` subscription shows in status until
then). `billing_time` is `anniversary`.
- 400 `BILLING_PLAN_NOT_AVAILABLE` — not in `PUBLIC_PLAN_CODES`.
- 402 `BILLING_PAYMENT_METHOD_REQUIRED` — paid plan but no card saved on the
  Stripe customer (or Lago hasn't linked one yet). Free plan never needs one.
- 409 `BILLING_ALREADY_ON_PLAN`.
- 404 `BILLING_CUSTOMER_NOT_FOUND` — no active subscription.

### DELETE /companies/:companyId/billing/subscription
Cancel. Assigns `FREE_PLAN_CODE`; never terminates the subscription, so a
company always has an active plan. 409 `BILLING_ALREADY_ON_PLAN` if already
on free.

## Errors
`BillingError` (`billingUtility.ts`) mirrors `ProxyError`: `errorHandler`
answers with `{ error, code }`.

| status | code | meaning |
|---|---|---|
| 503 | `BILLING_UNAVAILABLE` | Lago/Stripe unreachable, 5xx, or rejected **our** key (logged at error) |
| 502 | `BILLING_REJECTED` | provider returned a 4xx we can't attribute to the caller |
| 404 | `BILLING_CUSTOMER_NOT_FOUND` | |
| 404 | `BILLING_PAYMENT_METHOD_NOT_FOUND` | unknown id, or another customer's card |
| 409 | `BILLING_CUSTOMER_EXISTS` | |
| 409 | `BILLING_ALREADY_ON_PLAN` | |
| 400 | `BILLING_PLAN_NOT_AVAILABLE` | plan code not whitelisted |
| 402 | `BILLING_PAYMENT_METHOD_REQUIRED` | paid plan chosen with no saved card |
| 409 | `BILLING_PROVIDER_NOT_LINKED` | |
| 404 | `BILLING_COUPON_NOT_FOUND` | unknown code |
| 422 | `BILLING_COUPON_NOT_APPLICABLE` | `details.reason` ∈ `already_used`, `terminated`, `expired`, `already_applied`, `pending_free_downgrade`, `not_reusable`, `plan_overlap`, `currency_mismatch`, `other` |
| 409 | `BILLING_COUPON_REQUIRES_PAID_PLAN` | standalone apply on free / pending downgrade to free, or coupon on a change to free |
| 429 | `RATE_LIMITED` | coupon check/apply, per user and per company |

`BillingError` can carry `details`; `errorHandler` adds it to the body when
set (`{ error, code, details }`). Today only the coupon 422 uses it.

## Coupons

Coupons are **created in the Lago console**, never here. They attach to the
Lago *customer* and are deducted from the next subscription invoices, before
tax. Code in `src/services/couponCheck.ts` (rules), `src/lib/lago.ts`
(calls), routes at the bottom of `billing.routes.ts`.

- **Coupon table (viasocket) is the gate.** Lago has no coupon metadata and
  no global one-time use, so each redeemable code has a row in a viasocket
  table (ids hard-coded in `src/lib/couponTable.ts`, key in `COUPON_TABLE_AUTH_KEY`). No row,
  or `internal_coupon` set → 404, so internal Lago coupons can't be redeemed
  whatever their code. Columns: `discount_coupon` (what the user types),
  `original_coupon` (the Lago code to apply; blank = same), `internal_coupon`,
  `is_single_use` + `is_used` (global one-time; `is_used` is set after a
  successful apply, best effort, logged at error if the write fails),
  `skip_payment_method` (upgrade without a card — pair it with a 100% or
  plan-amount coupon in Lago, or the invoice can't be collected).
- **Check, then apply.** `GET .../coupons/:code` is read only and returns
  `{ coupon, applicable, blockers[], warnings[] }`. Blockers: `already_used`, `terminated`,
  `expired`, `already_applied` (active on this customer, even if reusable, so
  nothing stacks), `pending_free_downgrade`. Warnings: `plan_mismatch`
  (plan-limited coupon that doesn't cover the relevant plan: the `plan_code`
  query during an upgrade, else the current plan), `currency_mismatch`.
  Lago still enforces its own rules on apply; the check exists so the UI
  can explain *before* a one-time coupon is consumed.
- **Free plan.** A percentage `once` coupon is consumed by the very next
  invoice, even a $0 one. So standalone apply is refused on the free plan or
  with a pending downgrade to free, and a plan change *to* free refuses a
  coupon. A free→paid upgrade with a coupon is fine (see PUT above).
- **Rate limit.** `COUPON_RATE_PER_USER` (20) and `COUPON_RATE_PER_COMPANY`
  (60) per `COUPON_RATE_WINDOW_MS` (1h), because the check endpoint tells
  valid codes from unknown ones.
- **Audit.** `billing.coupon.apply` on standalone apply; inside a plan
  change the coupon is part of the `billing.plan.change` detail.
- Lago's 422 codes for applied coupons aren't in its OpenAPI spec; the
  `reason` mapping in `applyLagoCoupon` is best effort and the raw code is
  logged at warn.
- Rules self-check: `LAGO_API_KEY=x STRIPE_SECRET_KEY=x npx tsx scripts/check-coupon-rules.ts`.

## Not verified live (2026-09-05)
The `LAGO_API_KEY` in `.env` was rejected (401) by both `api.getlago.com`
and `api.eu.getlago.com`, so the Lago calls were written against the
public API reference but not exercised. Stripe's key was verified.
