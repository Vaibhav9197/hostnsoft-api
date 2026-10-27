/**
 * Config for Integrations — see docs/integrations.md. Optional with
 * defaults except the two that identify Embarko on viasocket, same
 * convention as src/lib/scheduleConfig.ts.
 *
 * Those two are the whole feature's gate: with either unset, every
 * Integrations route answers 503
 * `integrations_not_configured` rather than the service refusing to start.
 * Deploys, env vars and schedules must keep working on an environment
 * that was never onboarded to viasocket.
 *
 * Nothing in this file (or anywhere a customer can see) says "viasocket":
 * the product name is Integrations. The viasocket names survive only in
 * these server-side variable names and in this repo's docs.
 */
import { envNumber } from "./env";

// Signs every SSO token Embarko mints, for the service user and for
// members. Server-side only, same rules as PROXY_ADMIN_TOKEN: never
// logged, never returned by any endpoint, never sent to a browser.
export const VIASOCKET_PARTNER_KEY: string = process.env.VIASOCKET_PARTNER_KEY?.trim() || "";

// Embarko's own workspace on viasocket — the `parent_company_id` every SSO
// token carries, and the prefix viasocket puts on the workspaces it makes
// for us (`<this>-<title>`). No default: it identifies one viasocket
// account, differs per environment, and a wrong value would sign tokens
// against someone else's workspace. Required, like the key.
export const VIASOCKET_PARENT_ORG_ID: string = process.env.VIASOCKET_PARENT_ORG_ID?.trim() || "";

export const VIASOCKET_API_BASE: string =
  process.env.VIASOCKET_API_BASE?.trim().replace(/\/+$/, "") || "https://flow-api.viasocket.com";


// Where a member's browser is sent to land inside viasocket signed in.
export const VIASOCKET_APP_BASE: string =
  process.env.VIASOCKET_APP_BASE?.trim().replace(/\/+$/, "") || "https://flow.viasocket.com";

// Lifetime of every SSO token this service signs. Short on purpose: the
// token travels in a URL (query string), which browsers keep in history
// and intermediaries log, so a copied link is useless within minutes. The
// viasocket session it yields is used once and never stored.
export const INTEGRATIONS_SSO_TOKEN_TTL_S: number = envNumber("INTEGRATIONS_SSO_TOKEN_TTL_S", 300);

// Whether the feature is usable at all in this environment. Both halves of
// the viasocket identity are needed: the key signs the token, the parent
// workspace says who it is signed for.
export function integrationsConfigured(): boolean {
  return VIASOCKET_PARTNER_KEY.length > 0 && VIASOCKET_PARENT_ORG_ID.length > 0;
}
