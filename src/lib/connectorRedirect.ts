// Allowlist of external redirect_uri prefixes the MSG91 callback (see
// GET /auth/msg91/callback in auth.routes.ts) is permitted to redirect to
// when an AI-connector supplies one. This is the connector equivalent of a
// registered OAuth client redirect_uri: deliberately NOT caller-controlled -
// only a `redirect_uri` matching a prefix configured here (ops-controlled,
// comma-separated) is honored. Anything else falls through to the existing
// same-origin `next` + FRONTEND_ORIGIN behavior untouched, so this is
// additive and doesn't change the dashboard's own login flow.
//
// Named `redirect_uri` (not `redirect_url`) deliberately - it's the standard
// OAuth authorization-request param name, matching what a generic OAuth
// proxy (e.g. viasocket-mcp) already sends with no special-casing for us.
const ALLOWED_CONNECTOR_REDIRECT_PREFIXES: string[] = (
  process.env.CONNECTOR_ALLOWED_REDIRECT_PREFIXES ?? "https://mcp.viasocket.com/oauth/"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function resolveConnectorRedirect(redirectUri: unknown): string | null {
  if (typeof redirectUri !== "string" || redirectUri.length === 0) return null;
  const isAllowed = ALLOWED_CONNECTOR_REDIRECT_PREFIXES.some((prefix) => redirectUri.startsWith(prefix));
  return isAllowed ? redirectUri : null;
}
