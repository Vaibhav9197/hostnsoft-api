/**
 * The human-readable notices that tell a deployer how to get a deploy token.
 * Built here (not in hostnsoft-deploy) since this service is the one that
 * knows the dashboard's URL and its own public URL; hostnsoft-deploy just
 * relays these strings verbatim in its own deploy responses.
 *
 * Written as complete, self-contained instruction sequences — an AI agent
 * relaying them to a human user should be able to read them alone and
 * correctly explain every step, without also needing platform docs. Two
 * paths are always offered: the dashboard, and the public email endpoint
 * (see docs/plans/2026-09-08-001-feat-email-deploy-token-api-plan.md).
 * `buildTokenSteps()` carries the same content in structured form for
 * callers that want to render it themselves.
 */
import { FRONTEND_ORIGIN } from "./frontendOrigin";
import { API_PUBLIC_URL } from "./publicTokenConfig";

export const ORPHAN_LOGIN_URL = `${FRONTEND_ORIGIN}/app`;
export const PUBLIC_TOKEN_REQUEST_URL = `${API_PUBLIC_URL}/public/deploy-tokens/request`;

const DASHBOARD_STEPS = [
  `Open ${FRONTEND_ORIGIN} and sign in (or create an account).`,
  `Select your company (create one if you don't have any).`,
  `Open "Deploy Tokens" for that company.`,
  `Create a token (or copy an existing one).`,
];

const API_STEPS = [
  `Send POST ${PUBLIC_TOKEN_REQUEST_URL} with header "Content-Type: application/json" ` +
  `and JSON body {"email": "<your email address>"}.`,
  `If you have no account yet, one is created for you along with a company.`,
  `Check that inbox (and spam): a new deploy token for each of your companies is emailed to it (existing tokens keep working).`,
  `Copy the token from the email.`,
];

// Structured form of the same instructions — for a JSON response field
// (see unauthorizedDeployTokenBody and the orphan claim response).
export function buildTokenSteps() {
  return {
    dashboard: { url: FRONTEND_ORIGIN, steps: DASHBOARD_STEPS },
    api: {
      method: "POST",
      url: PUBLIC_TOKEN_REQUEST_URL,
      body: { email: "<your email address>" },
      steps: API_STEPS,
    },
    useToken: `Pass the token as the Authorization header when deploying.`,
  };
}

const numbered = (steps: string[]) => steps.map((s, i) => `${i + 1}) ${s}`).join(" ");

// Both ways to obtain a deploy token, as numbered sequences that can be
// embedded in a longer message. Never includes caller-specific data.
export function buildTokenGuidance(): string {
  return (
    `Option A (dashboard): ${numbered(DASHBOARD_STEPS)} ` +
    `Option B (no browser, API): ${numbered(API_STEPS)}`
  );
}

// For a request whose Authorization token was present but invalid/revoked.
export function buildInvalidTokenGuidance(): string {
  return (
    `The deploy token you sent is not valid (unknown, revoked, or expired). ` +
    `Get a working token. ${buildTokenGuidance()} ` +
    `Then retry the deploy with the new token as the Authorization header.`
  );
}

// For an anonymous ("orphan") deploy — see docs/Anonymous-deploy-req.md #4.
// `claimUrl` is the one-time claim link minted on the deploy that created
// the orphan (lib/orphanClaim.ts): when it's known, keeping the app is
// "open this link and sign in", and the token path is the fallback. An
// anonymous redeploy of an existing orphan has no link to give (the code
// was shown once), so it gets the token-only wording as before.
export function buildOrphanMessage(expiresAt: Date, claimUrl?: string | null): string {
  const iso = expiresAt.toISOString();
  const intro =
    `This app was deployed without a deploy token, so it is temporary and will be deleted at ${iso} unless claimed. `;
  if (claimUrl) {
    return (
      intro +
      `To keep it, give the user this link and ask them to open it and sign in (or sign up): ${claimUrl} ` +
      `The link works only for them and only until the deadline; it needs no redeploy and no source code. ` +
      `Fallback if the link is lost: get a deploy token (${buildTokenGuidance()}) and redeploy this exact app name ` +
      `with that token as the Authorization header before the deadline. Either way the app keeps its URL and this notice goes away.`
    );
  }
  return (
    intro +
    `To keep it, get a deploy token. ${buildTokenGuidance()} ` +
    `Then redeploy this exact app name using that token as the Authorization header ` +
    `before the deadline above. Redeploying with a valid token before expiry ` +
    `permanently keeps this app and removes this notice.`
  );
}
