// See docs/msg91-proxy-auth.md — MSG91 owns the login/signup/forgot-password
// UI via a hosted widget and hands the client a proxy_auth_token. This
// backend must never trust that token until it's exchanged here.

const MSG91_GET_DETAILS_URL = "https://routes.msg91.com/api/c/getDetails";

export interface Msg91Identity {
  id: string;
  name: string;
  email: string | null;
  company: { id: string; name: string } | null;
}

export class Msg91AuthError extends Error {}

export async function verifyProxyAuthToken(token: string): Promise<Msg91Identity> {
  const response = await fetch(MSG91_GET_DETAILS_URL, {
    headers: { proxy_auth_token: token },
  });

  if (!response.ok) {
    throw new Msg91AuthError("MSG91 rejected the proxy_auth_token");
  }

  const body = (await response.json()) as { data?: Array<Record<string, any>> };
  const record = body?.data?.[0];
  if (!record?.id) {
    throw new Msg91AuthError("MSG91 returned no identity for this token");
  }

  return {
    id: String(record.id),
    name: record.name || record.meta?.name || "MSG91 User",
    email: record.email || record.meta?.email || null,
    company: record.currentCompany?.id
      ? {
          id: String(record.currentCompany.id),
          name: record.currentCompany.name || "Unnamed company",
        }
      : null,
  };
}
