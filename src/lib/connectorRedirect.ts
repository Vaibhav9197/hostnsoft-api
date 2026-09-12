// Allowlist of external redirect_uri targets the MSG91 callback (see
// GET /auth/msg91/callback in auth.routes.ts) is permitted to redirect to
// when an AI-connector supplies one. This is the connector equivalent of a
// registered OAuth client redirect_uri: deliberately NOT caller-controlled -
// only a `redirect_uri` matching an entry configured here (ops-controlled,
// comma-separated) is honored. Anything else falls through to the existing
// same-origin `next` + FRONTEND_ORIGIN behavior untouched, so this is
// additive and doesn't change the dashboard's own login flow.
//
// Named `redirect_uri` (not `redirect_url`) deliberately - it's the standard
// OAuth authorization-request param name, matching what a generic OAuth
// proxy (e.g. viasocket-mcp) already sends with no special-casing for us.
//
// Comparison is by parsed origin + path-prefix, NOT raw string prefix
// matching: a bare startsWith check would let a configured entry like
// "https://partner.com" (no trailing slash - an easy mistake, and the only
// thing saving the old check today is that the default happens to end in
// "/oauth/") also match "https://partner.com.evil.com", since that string
// literally starts with the same characters. Parsing both sides into an
// origin (scheme+host+port) and a normalized path prefix closes that off
// regardless of how an entry is written.
type AllowedTarget = { origin: string; pathPrefix: string };

function parseAllowedEntry(entry: string): AllowedTarget | null {
    try {
        const u = new URL(entry);
        const pathPrefix = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
        return { origin: u.origin, pathPrefix };
    } catch {
        return null;
    }
}

const ALLOWED_TARGETS: AllowedTarget[] = (
    process.env.CONNECTOR_ALLOWED_REDIRECT_PREFIXES ?? "https://mcp.viasocket.com/oauth/"
)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseAllowedEntry)
    .filter((t): t is AllowedTarget => t !== null);

export function resolveConnectorRedirect(redirectUri: unknown): string | null {
    if (typeof redirectUri !== "string" || redirectUri.length === 0) return null;

    let parsed: URL;
    try {
        parsed = new URL(redirectUri);
    } catch {
        return null;
    }
    // Never hand a live credential back over plain HTTP.
    if (parsed.protocol !== 'https:') return null;

    const isAllowed = ALLOWED_TARGETS.some(
        (target) => target.origin === parsed.origin && parsed.pathname.startsWith(target.pathPrefix)
    );
    return isAllowed ? redirectUri : null;
}
