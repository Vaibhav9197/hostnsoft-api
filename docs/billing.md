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
| `/companies/:companyId/billing/subscription` | PUT | change plan (`{ plan_code }`, must be in `PUBLIC_PLAN_CODES`) |
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
Body `{ plan_code }`. Lago upserts the company's single subscription
(`external_id` = company id) with the new plan: upgrades apply immediately,
downgrades at period end (a `pending` subscription shows in status until
then). `billing_time` is `anniversary`.
- 400 `BILLING_PLAN_NOT_AVAILABLE` — not in `PUBLIC_PLAN_CODES`.
- 402 `BILLING_PAYMENT_METHOD_REQUIRED` — paid plan but no card saved on the
  Stripe customer (or Lago hasn't linked one yet). Free plan never needs one.
- 409 `BILLING_ALREADY_ON_PLAN`.
- 404 `BILLING_CUSTOMER_NOT_FOUND` — no active subscription.

On success it also starts the footer sync for the company in the
background (see below), so an upgrade removes the footer from its apps
straight away. The response doesn't wait for it.

### DELETE /companies/:companyId/billing/subscription
Cancel. Assigns `FREE_PLAN_CODE`; never terminates the subscription, so a
company always has an active plan. 409 `BILLING_ALREADY_ON_PLAN` if already
on free.

## Plan and the app footer

Free-plan apps show a "hosted on Embarko" footer (with the Embarko logo);
any paid plan removes it. hostnsoft-deploy injects it — see its
`docs/Footer-flag-req.md`. This service decides who gets it:

- **Free** = `isCompanyOnFreePlan` (`src/services/companyPlan.ts`): no
  active subscription, no Lago customer at all, or `FREE_PLAN_CODE`.
  `null` when Lago can't be asked.
- **Every deploy and push carries it.** The deploy claim, every config push
  (`pushAppConfig` — custom domains, env vars, rollback) and every rename
  send `isFreePlan`. Before this, pushes and renames left it out and
  hostnsoft-deploy rebuilt free apps without their footer. When Lago is
  unreachable they send `false` (never block or change a deploy for a
  paying customer); the sync below corrects it once Lago answers.
- **Footer sync** (`src/services/footerSync.ts`). For each of a company's
  deployed, claimed apps it calls hostnsoft-deploy's
  `POST /internal/apps/:slug/footer { show }`, which flips the footer in
  seconds with no restart. On `409 config_push_required` (static app, app
  with no footer sidecar to switch on, or one deployed before the flag
  existed) it re-pushes the app's current config with the plan instead —
  no new deployment row, but a container app restarts once — and writes a
  `project.footer.push` audit row. Runs:
  - after a successful `PUT .../billing/subscription` (upgrades are live
    at once; a pending downgrade finds the old plan and changes nothing);
  - every `FOOTER_SYNC_INTERVAL_MS` (6h) for every company with deployed
    apps, which is what applies a downgrade or cancel at period end, a
    failed payment, or a plan changed in the Lago console. A company is
    skipped while its plan matches the last one fully applied, for up to
    `FOOTER_SYNC_REFRESH_MS` (24h). That record is in memory, so the first
    run after a restart re-applies everyone.
  - Lago unreachable → that company is skipped, nothing changes.
  - Config pushes are spaced by `FOOTER_SYNC_PUSH_GAP_MS` (5s), so the
    first run after release — every free app needs one push to get the
    flag mount — doesn't restart everything at once.

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

## Not verified live (2026-09-05)
The `LAGO_API_KEY` in `.env` was rejected (401) by both `api.getlago.com`
and `api.eu.getlago.com`, so the Lago calls were written against the
public API reference but not exercised. Stripe's key was verified.
