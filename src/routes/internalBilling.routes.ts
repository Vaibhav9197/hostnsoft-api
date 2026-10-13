import { Router } from "express";
import { requireInternalSecret } from "../middleware/requireInternalSecret";
import { resyncCompanyFooters } from "../services/footerResync";
import { FREE_PLAN_CODE } from "../lib/billingUtility";
import { rememberCompany } from "../services/companyStore";

export const internalBillingRouter = Router();

// Lago subscription events, relayed through viaSocket
// (Lago -> viaSocket -> this endpoint). Lago can't attach custom headers
// to its webhooks, so viaSocket receives the Lago webhook and forwards the
// payload here with the x-internal-secret header set. Fires when a
// subscription starts, is terminated, or a scheduled downgrade lands at
// end-of-period — none of which pass through our API. We only care about one case: the company just LANDED on the
// free plan (end-of-period downgrade, or a failed payment moving them to
// free), which is when the footer must come back. Paid -> paid changes
// nothing, and free -> paid is handled synchronously in billing.routes.ts.
internalBillingRouter.post("/internal/billing/lago/webhook", requireInternalSecret, (req, res) => {
  const { webhook_type, subscription } = req.body ?? {};
  const companyId = subscription?.external_customer_id;
  const planCode = subscription?.plan_code ?? subscription?.plan?.code;
  if (webhook_type === "subscription.started" && typeof companyId === "string" && companyId && typeof planCode === "string") {
    rememberCompany(companyId, { planCode });
    if (planCode === FREE_PLAN_CODE) {
      resyncCompanyFooters(companyId, `lago ${webhook_type} -> ${planCode}`);
    }
  }
  // Always 200: Lago/viaSocket retry non-2xx, and an event we don't act on is not an error.
  res.json({ ok: true });
});
