/**
 * Every outbound webhook this service calls, in one place. Automation
 * (email, notifications, …) is delegated to viasocket flows: the code POSTs
 * a JSON payload to the flow's webhook URL and viasocket does the rest.
 *
 * URLs are constants here, not env — this enum IS the registry. Add new
 * webhooks as new members.
 */
import { logger } from "./logger";

export enum Webhook {
  // Mails default deploy tokens to a person — see src/services/publicTokenRequest.ts.
  // Payload documented in docs/email-templates/deploy-token.md.
  DEPLOY_TOKEN_EMAIL = "https://flow.sokt.io/func/scriCDraa3NO",
  // "Contact Dev" on a Showcase app page, relayed by POST /public/customer-query
  // with `toEmail` — see src/routes/publicCustomerQuery.routes.ts. Same
  // payload shape as the token mail (`to`, `subject`, `variables.content`).
  // ponytail: same flow URL; give it its own flow when the mail needs its own look.
  SHOWCASE_CONTACT_EMAIL = "https://flow.sokt.io/func/scriCDraa3NO",
  // Showcase listing pending / approved / rejected — see src/services/showcaseMail.ts.
  // ponytail: same flow URL as above.
  SHOWCASE_NOTIFY_EMAIL = "https://flow.sokt.io/func/scriCDraa3NO",
  // A schedule started failing / recovered — see src/services/scheduleAlerts.ts.
  // ponytail: same flow URL as above.
  SCHEDULE_ALERT_EMAIL = "https://flow.sokt.io/func/scriCDraa3NO",
  // Someone was invited to a workspace — see src/services/workspaceRoles.ts
  // createInvite and src/lib/memberInviteEmail.ts. Proxy's addUser sends no
  // email itself.
  // ponytail: same flow URL as above; give it its own flow when it needs one.
  MEMBER_INVITE_EMAIL = "https://flow.sokt.io/func/scriCDraa3NO",
  // An app (via its AI) asked for Integrations in a workspace where it is
  // off: tells the Owners, who are the only ones who can turn it on.
  INTEGRATIONS_REQUEST_EMAIL = "https://flow.sokt.io/func/scriCDraa3NO",
}

export class WebhookError extends Error { }

// Enum member name for a URL, for log lines (never log the URL's payload).
const WEBHOOK_NAMES = new Map(Object.entries(Webhook).map(([name, url]) => [url, name]));

// POSTs `payload` as JSON. Any non-2xx or network failure throws; callers
// decide whether that is fatal. The payload is never logged — it may carry
// secrets (deploy tokens).
export async function callWebhook(hook: Webhook, payload: unknown): Promise<void> {
  const name = WEBHOOK_NAMES.get(hook) ?? "unknown";
  let response: Response;
  try {
    response = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new WebhookError(`webhook ${name} unreachable: ${(err as Error)?.message}`);
  }
  if (!response.ok) {
    logger.error(`[webhooks] ${name} returned ${response.status}`);
    throw new WebhookError(`webhook ${name} returned ${response.status}`);
  }
}
