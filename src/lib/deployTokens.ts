import crypto from "crypto";

// Deploy tokens are high-entropy random strings, not user passwords — a
// fast SHA-256 hash (rather than bcrypt) is the right tradeoff since these
// get checked on every hostnsoft-deploy call and can't be brute-forced from
// the hash alone.
// Who minted a token. Stored on DeployToken.source; string column (SQLite
// has no enums) so this union is the single source of truth.
// "connector" — minted by POST /connector/token, exchanging a proxy_auth_token
// for a deploy token so an AI client (ChatGPT/Claude connector) never sees
// a login page — see src/routes/connectorAuth.routes.ts.
export const DEPLOY_TOKEN_SOURCES = ["dashboard", "agent", "connector"] as const;
export type DeployTokenSource = (typeof DEPLOY_TOKEN_SOURCES)[number];

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Newly minted tokens carry the product's own prefix. Tokens minted before
// the hostnsoft -> Embarko rename still start `hns_` and stay valid: the
// prefix is display-only (it identifies a token in the dashboard list and
// makes a leaked credential recognizable in a log or a repo scan), and
// authentication is a hash lookup on the whole string, never a prefix
// check. So both forms coexist indefinitely with no migration and no
// forced rotation — don't add a prefix check anywhere, or every token
// issued before this change stops working.
const TOKEN_PREFIX = "emb_";

export function generateDeployToken(): {
  token: string;
  prefix: string;
  tokenHash: string;
} {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
  return {
    token,
    prefix: token.slice(0, 12),
    tokenHash: hashToken(token),
  };
}
