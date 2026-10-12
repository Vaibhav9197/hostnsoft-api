// Self-check for the coupon check rules (no Lago key needed):
//   npx tsx scripts/check-coupon-rules.ts
import assert from "node:assert/strict";
import { evaluateCoupon } from "../src/services/couponCheck";
import type { LagoCoupon } from "../src/lib/lago";

const base: LagoCoupon = {
  lago_id: "c1", name: "Ten", code: "EMB-TEN", coupon_type: "percentage", percentage_rate: "10.0",
  frequency: "once", reusable: true, limited_plans: false, expiration: "no_expiration",
};
const row = { discount_coupon: "EMB-TEN" };
const ctx = { row, appliedCodes: [], pendingFreeDowngrade: false, relevantPlanCode: "pro", relevantPlanCurrency: "USD", isUpgrade: false };

let r = evaluateCoupon({ coupon: base, ...ctx });
assert.equal(r.applicable, true); assert.deepEqual(r.warnings, []);

r = evaluateCoupon({ coupon: { ...base, limited_plans: true, plan_codes: ["team"] }, ...ctx, isUpgrade: true });
assert.deepEqual(r.warnings, ["plan_mismatch"]); assert.equal(r.applicable, true);

r = evaluateCoupon({ coupon: { ...base, limited_plans: true, plan_codes: ["pro"] }, ...ctx, isUpgrade: true });
assert.deepEqual(r.warnings, []);

r = evaluateCoupon({ coupon: base, ...ctx, appliedCodes: ["emb-ten"] });
assert.deepEqual(r.blockers, ["already_applied"]);

r = evaluateCoupon({ coupon: base, ...ctx, pendingFreeDowngrade: true });
assert.deepEqual(r.blockers, ["pending_free_downgrade"]);
r = evaluateCoupon({ coupon: base, ...ctx, pendingFreeDowngrade: true, isUpgrade: true });
assert.deepEqual(r.blockers, []);

r = evaluateCoupon({ coupon: { ...base, expiration: "time_limit", expiration_at: "2020-01-01T00:00:00Z" }, ...ctx });
assert.deepEqual(r.blockers, ["expired"]);
r = evaluateCoupon({ coupon: { ...base, terminated_at: "2025-01-01T00:00:00Z" }, ...ctx });
assert.deepEqual(r.blockers, ["terminated"]);

r = evaluateCoupon({ coupon: { ...base, coupon_type: "fixed_amount", amount_cents: 500, amount_currency: "EUR", percentage_rate: null }, ...ctx });
assert.deepEqual(r.warnings, ["currency_mismatch"]);
assert.equal(r.coupon.amountCents, 500);

r = evaluateCoupon({ coupon: base, ...ctx, row: { ...row, is_single_use: true, is_used: true } });
assert.deepEqual(r.blockers, ["already_used"]);
r = evaluateCoupon({ coupon: base, ...ctx, row: { ...row, skip_payment_method: true } });
assert.equal(r.skipPaymentMethod, true);
r = evaluateCoupon({ coupon: { ...base, code: "lago-internal-code" }, ...ctx, row: { ...row, original_coupon: "lago-internal-code" } });
assert.equal(r.coupon.code, "EMB-TEN");

console.log("coupon rules ok");
