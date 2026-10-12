// Coupon metadata that Lago doesn't model, kept in a viasocket table
// (docs/billing.md "Coupons"). The table is the gate: a code the user types
// must have a row here, else it's "not found" — so internal Lago coupons are
// never redeemable from the panel, whatever their code.
//
// Columns: discount_coupon (what the user types), original_coupon (the Lago
// code to apply; empty = same as discount_coupon), internal_coupon (never
// redeemable here), is_single_use + is_used (global one-time use, which Lago
// can't express), skip_payment_method (waive the card on upgrade).
import { logger } from "./logger";
import { billingErrors } from "./billingUtility";

// Table location is fixed (one table for every environment); only the key
// comes from the environment.
const BASE_URL = "https://table-api.viasocket.com";
const DB_ID = "6acc6cbbbbff013524247756";
const TABLE_ID = "tblo41vhq";
const AUTH_KEY = process.env.COUPON_TABLE_AUTH_KEY ?? "";

export interface CouponRow {
  discount_coupon: string;
  original_coupon?: string | null;
  internal_coupon?: boolean | null;
  is_single_use?: boolean | null;
  is_used?: boolean | null;
  skip_payment_method?: boolean | null;
}

function configured(): boolean {
  return Boolean(AUTH_KEY);
}

async function tableRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!configured()) throw billingErrors.unavailable("lago", "coupon table not configured (COUPON_TABLE_AUTH_KEY)");
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/${DB_ID}/${TABLE_ID}${path}`, {
      ...init,
      headers: { "auth-key": AUTH_KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (err) {
    throw billingErrors.unavailable("lago", `coupon table unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw billingErrors.unavailable("lago", `coupon table returned ${res.status} on ${path}`);
  return (await res.json()) as T;
}

// Row for a user-facing code, or null. `code` is already validated to
// [A-Za-z0-9_-] by couponCodeSchema, so it's safe inside the filter string.
export async function getCouponRow(code: string): Promise<CouponRow | null> {
  const filter = encodeURIComponent(`discount_coupon = '${code}'`);
  const body = await tableRequest<{ data?: { rows?: CouponRow[] } }>(`?filter=${filter}&random=${Math.random()}`);
  const rows = body.data?.rows ?? [];
  return rows.find((r) => r.discount_coupon?.toUpperCase() === code.toUpperCase()) ?? rows[0] ?? null;
}

// The Lago coupon code behind a row.
export function lagoCodeFor(row: CouponRow): string {
  return row.original_coupon?.trim() || row.discount_coupon;
}

// Best effort; the caller already applied the coupon in Lago, so a failure
// here means the row is stale (logged at error) rather than the user is.
export async function markCouponUsed(code: string): Promise<void> {
  try {
    await tableRequest("", {
      method: "PUT",
      body: JSON.stringify({ records: [{ discount_coupon: code, is_used: true }], uniqueField: "discount_coupon" }),
    });
  } catch (err) {
    logger.error(`[coupon] failed to mark ${code} used in the coupon table: ${(err as Error).message}`);
  }
}
