/**
 * Is a company on the free plan? One definition, for every place that
 * decides whether an app shows the "hosted on Embarko" footer: the deploy
 * claim, every config push and rename, and the footer sync.
 *
 * A company with no active subscription — or no Lago customer at all yet —
 * is on the free tier by definition, same as the dashboard's billing.tsx.
 */
import { getActiveSubscription, LagoNotFound } from "../lib/lago";
import { FREE_PLAN_CODE } from "../lib/billingUtility";
import { logger } from "../lib/logger";

/** true / false, or null when Lago can't be asked right now. */
export async function isCompanyOnFreePlan(companyId: string): Promise<boolean | null> {
  try {
    const sub = await getActiveSubscription(companyId);
    return !sub || sub.plan_code === FREE_PLAN_CODE;
  } catch (err) {
    if (err instanceof LagoNotFound) return true;
    logger.warn(`[companyPlan] plan check failed for ${companyId}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The value to deploy with. Billing being unreachable must never block or
 * change a deploy for a paying customer, so unknown means "no footer"; the
 * footer sync puts it back once Lago answers (services/footerSync.ts).
 */
export async function isFreePlanForDeploy(companyId: string | null): Promise<boolean> {
  if (!companyId) return false;
  return (await isCompanyOnFreePlan(companyId)) ?? false;
}
