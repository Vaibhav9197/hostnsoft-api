// "Check" a coupon code for a company without applying it: a read-only Lago
// lookup plus local rules that turn Lago's coupon object into blockers
// (can't apply) and warnings (can apply, but it won't do what you expect).
// Lago still enforces on apply; this only exists so the UI can explain
// *before* a one-time coupon is consumed. See docs/billing.md "Coupons".
import {
  getLagoCoupon,
  getLagoPlan,
  listAppliedCoupons,
  listSubscriptions,
  type LagoCoupon,
} from "../lib/lago";
import { billingErrors, FREE_PLAN_CODE, type CouponRejectReason } from "../lib/billingUtility";
import { getCouponRow, lagoCodeFor, type CouponRow } from "../lib/couponTable";

export type CouponWarning = "plan_mismatch" | "currency_mismatch";

export interface CouponSummary {
  code: string;
  name: string;
  description: string | null;
  type: LagoCoupon["coupon_type"];
  amountCents: number | null;
  currency: string | null;
  percentageRate: string | null;
  frequency: LagoCoupon["frequency"];
  frequencyDuration: number | null;
  expiresAt: string | null;
  planCodes: string[] | null;
  reusable: boolean;
}

export interface CouponCheckResult {
  coupon: CouponSummary;
  applicable: boolean;
  blockers: CouponRejectReason[];
  warnings: CouponWarning[];
  // From the coupon table: this coupon waives the card on upgrade.
  skipPaymentMethod: boolean;
}

// A user-typed code resolved through the coupon table to its Lago code.
// Throws couponNotFound when the table has no (non-internal) row.
export async function resolveCouponRow(code: string): Promise<CouponRow> {
  const row = await getCouponRow(code);
  if (!row || row.internal_coupon) throw billingErrors.couponNotFound();
  return row;
}

export function summarizeCoupon(c: LagoCoupon): CouponSummary {
  return {
    code: c.code,
    name: c.name,
    description: c.description ?? null,
    type: c.coupon_type,
    amountCents: c.amount_cents ?? null,
    currency: c.amount_currency ?? null,
    percentageRate: c.percentage_rate ?? null,
    frequency: c.frequency,
    frequencyDuration: c.frequency_duration ?? null,
    expiresAt: c.expiration === "time_limit" ? (c.expiration_at ?? null) : null,
    planCodes: c.limited_plans ? (c.plan_codes ?? []) : null,
    reusable: c.reusable,
  };
}

// targetPlanCode is set when the check happens inside an upgrade dialog:
// then only the target plan matters for plan/currency warnings and a
// pending free downgrade is irrelevant (the upgrade replaces it).
export async function checkCoupon(
  companyId: string,
  code: string,
  targetPlanCode?: string
): Promise<CouponCheckResult> {
  const row = await resolveCouponRow(code);
  const [coupon, applied, subscriptions] = await Promise.all([
    getLagoCoupon(lagoCodeFor(row)),
    listAppliedCoupons(companyId),
    listSubscriptions(companyId),
  ]);
  if (!coupon) throw billingErrors.couponNotFound();

  const active = subscriptions.find((s) => s.status === "active");
  if (!active) throw billingErrors.noCustomer();

  const relevantPlanCode = targetPlanCode ?? active.plan_code;
  const plan = await getLagoPlan(relevantPlanCode);

  return evaluateCoupon({
    coupon,
    row,
    appliedCodes: applied.map((a) => a.coupon_code),
    pendingFreeDowngrade: subscriptions.some((s) => s.status === "pending" && s.plan_code === FREE_PLAN_CODE),
    relevantPlanCode,
    relevantPlanCurrency: plan?.amount_currency ?? null,
    isUpgrade: targetPlanCode != null,
  });
}

// Pure rules, kept separate from the Lago calls so they can be exercised
// without a key (scripts/check-coupon-rules.ts).
export function evaluateCoupon(input: {
  coupon: LagoCoupon;
  row: CouponRow;
  appliedCodes: string[];
  pendingFreeDowngrade: boolean;
  relevantPlanCode: string;
  relevantPlanCurrency: string | null;
  isUpgrade: boolean;
  now?: number;
}): CouponCheckResult {
  const { coupon, row, now = Date.now() } = input;
  const blockers: CouponRejectReason[] = [];
  // Global one-time use lives in the table, not Lago.
  if (row.is_single_use && row.is_used) blockers.push("already_used");
  if (coupon.terminated_at) blockers.push("terminated");
  if (coupon.expiration === "time_limit" && coupon.expiration_at && Date.parse(coupon.expiration_at) < now) {
    blockers.push("expired");
  }
  // Already active on this customer → block even if reusable, so a double
  // click or a second member can't stack the same discount twice.
  if (input.appliedCodes.some((c) => c.toUpperCase() === coupon.code.toUpperCase())) blockers.push("already_applied");
  if (!input.isUpgrade && input.pendingFreeDowngrade) blockers.push("pending_free_downgrade");

  const warnings: CouponWarning[] = [];
  if (coupon.limited_plans && !(coupon.plan_codes ?? []).includes(input.relevantPlanCode)) warnings.push("plan_mismatch");
  if (
    coupon.coupon_type === "fixed_amount" &&
    coupon.amount_currency &&
    input.relevantPlanCurrency &&
    coupon.amount_currency.toUpperCase() !== input.relevantPlanCurrency.toUpperCase()
  ) {
    warnings.push("currency_mismatch");
  }

  return {
    // Show the user the code they typed, not the Lago alias behind it.
    coupon: { ...summarizeCoupon(coupon), code: row.discount_coupon },
    applicable: blockers.length === 0,
    blockers,
    warnings,
    skipPaymentMethod: Boolean(row.skip_payment_method),
  };
}
