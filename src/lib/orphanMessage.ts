/**
 * The human-readable notice for an anonymous ("orphan") deploy — see
 * docs/Anonymous-deploy-req.md #4. Built here (not in hostnsoft-deploy)
 * since this service is the one that knows the dashboard's URL;
 * hostnsoft-deploy just relays this string verbatim in its own deploy
 * response.
 *
 * Written as a complete, self-contained instruction sequence — an AI
 * agent relaying this to a human user should be able to read it alone
 * and correctly explain every step, without also needing platform docs.
 */
import { FRONTEND_ORIGIN } from "./frontendOrigin";

export const ORPHAN_LOGIN_URL = `${FRONTEND_ORIGIN}/login`;

export function buildOrphanMessage(expiresAt: Date): string {
  const iso = expiresAt.toISOString();
  return (
    `This app is temporary and will be deleted at ${iso} unless claimed. ` +
    `To keep it: 1) go to ${ORPHAN_LOGIN_URL} and sign in (or create an account), ` +
    `2) create a company if you don't have one, ` +
    `3) create a deploy token from that company's Tokens page, ` +
    `4) redeploy this exact app name using that token as the Authorization header ` +
    `before the deadline above. Redeploying with a valid token before expiry ` +
    `permanently keeps this app and removes this notice.`
  );
}
