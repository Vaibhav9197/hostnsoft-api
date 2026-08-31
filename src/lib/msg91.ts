// MSG91 owns the login/signup UI via a hosted proxy-auth widget and hands
// the client a proxy_auth_token. This backend must never trust that token
// until it's exchanged here for a real MSG91-issued identity JWT.
//
// Verified 2026-08-27 against the live integration (a docs/msg91-proxy-auth.md
// description of a getDetails-based flow turned out not to match what
// MSG91 actually issues for this account — this replaces it entirely):
// POST-with-headers to generateAuthToken, using the account-level
// MSG91_AUTHKEY, returns { data: { jwt } } — a JWT whose payload carries
// `user` and `company` claims directly. This call MUST stay server-side:
// MSG91_AUTHKEY is account-wide (its own JWTs show permissions like
// create_authkey/delete_authkey/assign_permissions) — if it ever reaches
// a browser, treat it as compromised and rotate it in the MSG91 dashboard.

if (!process.env.MSG91_AUTHKEY) {
  throw new Error("MSG91_AUTHKEY environment variable is not set.");
}
const MSG91_AUTHKEY: string = process.env.MSG91_AUTHKEY;

if (!process.env.MSG91_GENERATE_AUTH_TOKEN_URL) {
  throw new Error("MSG91_GENERATE_AUTH_TOKEN_URL environment variable is not set.");
}
const MSG91_GENERATE_AUTH_TOKEN_URL: string = process.env.MSG91_GENERATE_AUTH_TOKEN_URL;

export interface Msg91Identity {
  id: string;
  name: string;
  email: string | null;
  company: { id: string; name: string } | null;
}

export class Msg91AuthError extends Error {}

interface Msg91JwtPayload {
  user?: { id?: string | number; name?: string; email?: string };
  company?: { id?: string | number; name?: string };
}

export async function verifyProxyAuthToken(token: string): Promise<Msg91Identity> {
  const response = await fetch(MSG91_GENERATE_AUTH_TOKEN_URL, {
    headers: {
      authkey: MSG91_AUTHKEY,
      proxy_auth_token: token,
    },
  });

  if (!response.ok) {
    throw new Msg91AuthError("MSG91 rejected the proxy_auth_token");
  }

  const body = (await response.json()) as { hasError?: boolean; data?: { jwt?: string } };
  if (body.hasError || !body.data?.jwt) {
    throw new Msg91AuthError("MSG91 did not return a valid auth token");
  }

  const payload = decodeJwtPayload(body.data.jwt);
  if (!payload?.user?.id) {
    throw new Msg91AuthError("MSG91 auth token had no identity payload");
  }

  return {
    id: String(payload.user.id),
    name: payload.user.name || "MSG91 User",
    email: payload.user.email || null,
    company: payload.company?.id
      ? { id: String(payload.company.id), name: payload.company.name || "Unnamed company" }
      : null,
  };
}

// Decodes (does NOT cryptographically verify) the JWT's payload. Trust
// here comes from having just fetched this JWT directly from MSG91 over
// an authkey-authenticated call above, not from checking its signature —
// we don't have MSG91's HS256 signing secret and don't need it, since
// nothing untrusted had a chance to hand us a substitute value in between.
function decodeJwtPayload(jwt: string): Msg91JwtPayload | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
