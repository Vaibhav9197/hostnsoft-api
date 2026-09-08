/**
 * POST /public/deploy-tokens/request: ensure the email has an account and a
 * company, mint one NEW token per company (existing tokens untouched), mail them.
 *
 * Never throws: every failure is logged and swallowed so the response is
 * identical whether the address existed or not (no account enumeration).
 * Logs carry only a short hash of the email for the same reason.
 */
import { logger } from "../lib/logger";
import { hashToken } from "../lib/deployTokens";
import {
  getUserByEmail,
  createUserWithCompany,
  listCompaniesForUser,
  ProxyError,
  PROXY_USER_LIMIT_CODE,
  type ProxyCompany,
  type ProxyUser,
} from "../lib/msg91";
import { ensureBillingForCompany } from "./billingCustomer";
import { mintEmailToken } from "./emailToken";
import { Webhook, callWebhook } from "../lib/webhooks";
import { renderDeployTokenEmail, deployTokenEmailSubject } from "../lib/deployTokenEmail";
import { FRONTEND_ORIGIN } from "../lib/frontendOrigin";

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const fingerprint = (email: string) => hashToken(email).slice(0, 12);

async function createAccount(email: string): Promise<{ user: ProxyUser; companies: ProxyCompany[] }> {
  // Company named after the email: createCUsers reuses a company on exact
  // name match, so a domain-derived name could link into a stranger's company.
  const companyName = email.split("@")[0] || email;
  const created = await createUserWithCompany({ email, companyName });
  if (!created.isNewCompany) {
    logger.warn(`[publicToken] createCUsers reused an existing company for ${fingerprint(email)}`);
  }
  // Same never-throw billing bootstrap as POST /companies.
  await ensureBillingForCompany(created.company.id, { name: created.company.name, email });
  return { user: created.user, companies: [created.company] };
}

async function resolveAccount(email: string): Promise<{
  outcome: "existing" | "created";
  user: ProxyUser;
  companies: ProxyCompany[];
}> {
  const existing = await getUserByEmail(email);
  if (!existing) return { outcome: "created", ...(await createAccount(email)) };

  const companies = await listCompaniesForUser(existing.id);
  // An account with no company can't hold a token; give them one.
  if (companies.length === 0) return { outcome: "existing", ...(await createAccount(email)) };
  return { outcome: "existing", user: existing, companies };
}

export async function handlePublicTokenRequest(email: string): Promise<void> {
  const fp = fingerprint(email);
  const startedAt = Date.now();

  try {
    const { outcome, user, companies } = await resolveAccount(email);

    // One NEW token per company per request. Existing tokens (default or
    // otherwise) are never touched, so nothing already deployed breaks.
    const items = [];
    for (const company of companies) {
      const { token } = await mintEmailToken(company.id, { userId: user.id });
      items.push({ company: company.name, token });
    }

    // Delivery is a viasocket flow. The HTML is rendered here (any number of
    // companies) so the flow's template only places `variables.content`.
    // Payload shape is documented in docs/email-templates/deploy-token.md.
    try {
      await callWebhook(Webhook.DEPLOY_TOKEN_EMAIL, {
        to: [{ email }],
        subject: deployTokenEmailSubject(items),
        variables: {
          content: renderDeployTokenEmail({ items, dashboardUrl: FRONTEND_ORIGIN }),
        },
      });
    } catch (err) {
      // Minted but not delivered; the unused row is harmless and the next
      // request mints again.
      logger.error(
        `[publicToken] email delivery failed for ${fp} (${items.length} companies); ` +
          `tokens minted but not delivered:`,
        err
      );
      return;
    }

    logger.info(
      `[publicToken] ${outcome}: mailed ${items.length} token(s) to ${fp} in ${Date.now() - startedAt}ms`
    );
  } catch (err) {
    if (err instanceof ProxyError && err.code === PROXY_USER_LIMIT_CODE) {
      logger.error(`[publicToken] proxy user limit reached; cannot create account for ${fp}`);
    } else {
      logger.error(`[publicToken] request for ${fp} failed:`, err);
    }
  }
}
