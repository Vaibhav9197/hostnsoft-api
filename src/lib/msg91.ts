// Client for MSG91 "proxy", which owns our users, companies and membership.
// This API stores none of them.
//
// Two credentials, told apart by URL shape:
//   /{PROXY_USER_REFERENCE_ID}/...  admin key  `authkey: PROXY_ADMIN_TOKEN`
//   /c/...                          user key   `proxy_auth_token: <PAT>`
//
// PROXY_ADMIN_TOKEN is account-wide: server-side only, never logged. If it ever
// reaches a browser, rotate it in the MSG91 dashboard.
//
// Only generateAuthToken is verified against this account (2026-08-27). The
// other endpoints follow a working reference client but are unproven here,
// so response parsing fails closed rather than throwing.

import { TtlCache } from "./ttlCache";
import { logger } from "./logger";

for (const name of ["PROXY_ADMIN_TOKEN", "PROXY_BASE_URL", "PROXY_USER_REFERENCE_ID"] as const) {
  if (!process.env[name]) throw new Error(`${name} environment variable is not set.`);
}
const PROXY_ADMIN_TOKEN: string = process.env.PROXY_ADMIN_TOKEN!;
const PROXY_BASE_URL: string = process.env.PROXY_BASE_URL!.replace(/\/+$/, "");
// Doubles as the `feature_id` createCUsers expects (docs/create-user-and-company.md).
const PROXY_USER_REFERENCE_ID: string = process.env.PROXY_USER_REFERENCE_ID!;

const ADMIN_BASE = `${PROXY_BASE_URL}/${PROXY_USER_REFERENCE_ID}`;
const ADMIN_BASE_WITHOUT_REF_ID = `${PROXY_BASE_URL}`;
const USER_BASE = `${PROXY_BASE_URL}/c`;

const IDENTITY_TTL_MS = 5 * 60 * 1000;

// Carries its own status/code/public message so errorHandler can answer for
// it and routes need no try/catch. `code` lets callers branch when they
// need to (e.g. PROXY_TOKEN_REJECTED vs PROXY_UNAVAILABLE); status alone
// covers everyone else (errorHandler, isCompanyMember's "never 404").
export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly code?: string
  ) {
    super(message);
  }
}

// See proxyRequest's 402 branch.
export const PROXY_USER_LIMIT_CODE = "PROXY_USER_LIMIT";

function authError(message: string) {
  return new ProxyError(message, 401, "Authentication failed", "PROXY_TOKEN_REJECTED");
}

function rejectedError(message: string) {
  return new ProxyError(message, 502, "Identity service rejected the request");
}

// Unreachable, timed out, 5xx, or it rejected OUR admin key. Never surfaces
// as 404 — an outage must not look like "not a member".
function unavailableError(message: string) {
  return new ProxyError(message, 503, "Identity service unavailable", "PROXY_UNAVAILABLE");
}

type ProxyEnvelope<T> = {
  hasError?: boolean;
  message?: string;
  data?: { data?: T[]; jwt?: string; totalEntityCount?: number | string };
};

// GET /c/getDetails is shallower than the rest: results sit at `data[]`
// directly, not nested under `data.data[]` like every other endpoint here.
type ProxyFlatEnvelope<T> = {
  hasError?: boolean;
  message?: string;
  data?: T[];
};

// POST /c/createCompany returns the created company as a single object at
// `data`, not an array.
type ProxySingleEnvelope<T> = {
  hasError?: boolean;
  message?: string;
  data?: T;
};

// Which credential was sent decides what a 401 means: the user's PAT being
// rejected is their problem, our admin key being rejected is ours.
type Credential = "admin" | "user";

async function proxyRequest<T>(
  url: string,
  credential: Credential,
  init: RequestInit
): Promise<ProxyEnvelope<T>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw unavailableError(`proxy unreachable: ${(err as Error)?.message}`);
  }

  const path = url.slice(PROXY_BASE_URL.length);
  if (response.status >= 500) {
    throw unavailableError(`proxy returned ${response.status} on ${path}`);
  }
  if (response.status === 401 || response.status === 403) {
    if (credential === "admin") {
      logger.error(`[msg91] admin key rejected by proxy on ${path} (${response.status})`);
      throw unavailableError("proxy rejected the server's admin key");
    }
    throw authError("proxy rejected the proxy_auth_token");
  }
  if (response.status === 402) {
    // createCUsers: the workspace's user quota is exhausted. Every new-email
    // request fails this way until the plan changes, so it gets its own code.
    throw new ProxyError(
      `proxy returned 402 (user limit) on ${path}`,
      502,
      "Identity service user limit reached",
      PROXY_USER_LIMIT_CODE
    );
  }
  if (response.status === 422) {
    // Proxy's input validation (e.g. updateCompany without an email). Its
    // message is meant for the user, so it surfaces as a 400 verbatim.
    const message = await response
      .json()
      .then((b: unknown) => { const m = (b as { message?: unknown })?.message; return typeof m === "string" ? m : null; })
      .catch(() => null);
    throw new ProxyError(
      `proxy returned 422 on ${path}: ${message ?? "unknown"}`,
      400,
      message ?? "Identity service rejected the input",
      "PROXY_INVALID_INPUT"
    );
  }
  if (!response.ok) {
    throw rejectedError(`proxy returned ${response.status} on ${path}`);
  }

  try {
    const result = await response.json()
    return result as ProxyEnvelope<T>;
  } catch {
    throw rejectedError(`proxy returned a non-JSON body on ${path}`);
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function adminRequest<T>(path: string, init: RequestInit = {}) {
  return proxyRequest<T>(`${ADMIN_BASE}${path}`, "admin", {
    ...init,
    headers: { ...JSON_HEADERS, authkey: PROXY_ADMIN_TOKEN, ...(init.headers ?? {}) },
  });
}


function adminRequestWithoutRefId<T>(path: string, init: RequestInit = {}) {
  return proxyRequest<T>(`${ADMIN_BASE_WITHOUT_REF_ID}${path}`, "admin", {
    ...init,
    headers: { ...JSON_HEADERS, authkey: PROXY_ADMIN_TOKEN, ...(init.headers ?? {}) },
  });
}

function userRequest<T>(proxyAuthToken: string, path: string, init: RequestInit = {}) {
  return proxyRequest<T>(`${USER_BASE}${path}`, "user", {
    ...init,
    headers: { ...JSON_HEADERS, proxy_auth_token: proxyAuthToken, ...(init.headers ?? {}) },
  });
}

// id, name are always present, normalised; proxy sends other fields too
// (email, meta, timezone, etc.) and those pass through as-is.
export interface ProxyCompany {
  id: string;
  name: string;
  [key: string]: unknown;
}

// id, name, email are always present, normalised; proxy may send other
// fields too (meta, created_at, etc.) and those pass through as-is rather
// than being dropped.
export interface ProxyUser {
  id: string;
  name: string;
  email: string | null;
  [key: string]: unknown;
}

// Proxy may send ids as numbers; normalised to strings at this boundary.
// Both allow arbitrary extra fields (proxy sends more than this) so they
// pass through rather than get silently dropped.
type RawCompany = ({ id?: string | number; name?: string } & Record<string, unknown>) | undefined;
type RawUser =
  | ({ id?: string | number; name?: string; email?: string } & Record<string, unknown>)
  | undefined;

function toCompany(raw: RawCompany): ProxyCompany | null {
  if (!raw?.id) return null;
  return { ...raw, id: String(raw.id), name: raw.name || "Unnamed workspace" };
}

function toUser(raw: RawUser): ProxyUser | null {
  if (!raw?.id) return null;
  return {
    ...raw,
    id: String(raw.id),
    name: raw.name || "",
    email: raw.email || null,
  };
}

export interface Msg91Identity extends ProxyUser {
  company: ProxyCompany | null;
}

interface Msg91JwtPayload {
  user?: RawUser;
  company?: RawCompany;
  org?: RawCompany; // some proxy tenants name it `org`
  exp?: number;
}

const identityByPat = new TtlCache<{ identity: Msg91Identity; exp: number | null }>(
  "identity",
  IDENTITY_TTL_MS
);

// Cached per PAT — the client resends the same PAT on every user-key call.
// A 401 here is blamed on the PAT: the admin key is the same one every
// other admin call just used successfully.
export async function verifyProxyAuthToken(proxyAuthToken: string): Promise<Msg91Identity> {
  const cached = await identityByPat.getOrLoad(
    proxyAuthToken,
    async () => {
      const body = await proxyRequest<never>(`${ADMIN_BASE}/generateAuthToken`, "user", {
        headers: { authkey: PROXY_ADMIN_TOKEN, proxy_auth_token: proxyAuthToken },
      });
      if (body.hasError || !body.data?.jwt) {
        throw authError("MSG91 did not return a valid auth token");
      }

      const payload = decodeJwtPayload(body.data.jwt);
      const user = toUser(payload?.user);
      if (!user) {
        throw authError("MSG91 auth token had no identity payload");
      }

      return {
        identity: { ...user, company: toCompany(payload?.company ?? payload?.org) },
        exp: typeof payload?.exp === "number" ? payload.exp : null,
      };
    },
    // Never cache past the JWT's own expiry.
    ({ exp }) => (exp === null ? IDENTITY_TTL_MS : Math.min(IDENTITY_TTL_MS, exp * 1000 - Date.now()))
  );
  return cached.identity;
}

// Decoded, not signature-verified: we don't hold MSG91's signing secret and
// don't need it, since we just fetched this JWT from MSG91 ourselves over an
// authkey-authenticated call.
function decodeJwtPayload(jwt: string): Msg91JwtPayload | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const companyCache = new TtlCache<ProxyCompany | null>("company", IDENTITY_TTL_MS);
const userCache = new TtlCache<ProxyUser | null>("user", IDENTITY_TTL_MS);

// The authorization primitive for every /companies/:companyId route. Proxy
// reports membership as a count and exposes no per-user role, which is why
// this API has no roles either. Not cached — always asks proxy fresh, so a
// removed member loses access immediately.
export async function isCompanyMember(userId: string, companyId: string): Promise<boolean> {
  if (!userId || !companyId) return false;

  const params = new URLSearchParams({ company_id: companyId, user_id: userId });
  const body = await adminRequest<unknown>(`/getDetails?${params}`);
  if (body.hasError) {
    throw rejectedError(`proxy refused getDetails: ${body.message ?? "unknown"}`);
  }
  const count = Number(body.data?.totalEntityCount);
  if (Number.isNaN(count)) {
    // Fail closed, and log so the field mapping gets fixed.
    logger.warn(
      `[msg91] unexpected getDetails shape: keys=${Object.keys(body.data ?? {}).join(",")}`
    );
    return false;
  }
  return count >= 1;
}

export function getCompanyById(companyId: string): Promise<ProxyCompany | null> {
  return companyCache.getOrLoad(
    companyId,
    async () => {
      const params = new URLSearchParams({ id: companyId });
      const body = await adminRequest<RawCompany>(`/getCompanies?${params}`);
      const company = toCompany(body.data?.data?.[0]);
      return company?.id === companyId ? company : null;
    },
    (company) => (company ? IDENTITY_TTL_MS : 0)
  );
}

export function getUserById(userId: string): Promise<ProxyUser | null> {
  return userCache.getOrLoad(
    userId,
    async () => {
      const params = new URLSearchParams({ user_id: userId });
      const body = await adminRequest<RawUser>(`/getDetails?${params}`);
      const user = toUser(body.data?.data?.[0]);
      return user?.id === userId ? user : null;
    },
    (user) => (user ? IDENTITY_TTL_MS : 0)
  );
}

export async function listMyCompanies(proxyAuthToken: string): Promise<ProxyCompany[]> {
  const body = await userRequest<RawCompany>(proxyAuthToken, `/getCompanies?pageNo=1&itemsPerPage=100`);
  return (body.data?.data ?? []).map(toCompany).filter((c): c is ProxyCompany => c !== null);
}

// GET /c/getDetails — user-key, no id needed: the PAT already identifies
// who's asking, so proxy returns their own full record rather than a
// lookup-by-id like getUserById (admin-key) does.
export async function getMyDetails(proxyAuthToken: string): Promise<ProxyUser | null> {
  const body = (await userRequest(proxyAuthToken, `/getDetails?fields=`)) as ProxyFlatEnvelope<RawUser>;
  return toUser(body.data?.[0]);
}

// Moves proxy's currentCompany for this PAT. Proxy returns a fresh JWT which
// we drop: company scope comes from the URL on every request, so there is
// nothing local to rebind. This exists so the company-aware proxy embed on
// the dashboard agrees with the company the dashboard is showing.
export async function switchCompany(proxyAuthToken: string, companyId: string): Promise<void> {
  const body = await userRequest<never>(proxyAuthToken, `/switchCompany`, {
    method: "POST",
    body: JSON.stringify({ company_ref_id: companyId }),
  });
  if (body.hasError) {
    throw rejectedError(`proxy refused switchCompany: ${body.message ?? "unknown"}`);
  }
  await identityByPat.delete(proxyAuthToken);
}

export interface CreateCompanyInput {
  name: string;
  email?: string;
  meta?: Record<string, unknown>;
  timezone?: string;
  timeZoneName?: string;
}

// POST /c/createCompany. The creator becomes a member and proxy switches
// them into it, so the cached identity for this PAT is stale afterward —
// same reasoning as switchCompany.
export async function createCompany(
  proxyAuthToken: string,
  company: CreateCompanyInput
): Promise<ProxyCompany> {
  const body = (await userRequest(proxyAuthToken, `/createCompany`, {
    method: "POST",
    body: JSON.stringify({ company }),
  })) as ProxySingleEnvelope<RawCompany>;

  if (body.hasError) {
    throw rejectedError(`proxy refused createCompany: ${body.message ?? "unknown"}`);
  }
  const created = toCompany(body.data);
  if (!created) {
    throw rejectedError("proxy did not return the created company");
  }

  await identityByPat.delete(proxyAuthToken);
  return created;
}

export interface UpdateCompanyInput {
  name: string;
  email: string;
  meta?: Record<string, unknown>;
  timezone?: string;
  timeZoneName?: string;
}

// PUT /c/updateCompany — acts on the PAT's *current* company (no id in the
// call), so callers switchCompany first when needed. Proxy requires name
// AND email on every update, and does not merge meta: send the full value.
export async function updateCompany(
  proxyAuthToken: string,
  companyId: string,
  company: UpdateCompanyInput
): Promise<ProxyCompany> {
  const body = (await userRequest(proxyAuthToken, `/updateCompany`, {
    method: "PUT",
    body: JSON.stringify({ company }),
  })) as ProxySingleEnvelope<RawCompany>;

  if (body.hasError) {
    throw rejectedError(`proxy refused updateCompany: ${body.message ?? "unknown"}`);
  }

  await Promise.all([identityByPat.delete(proxyAuthToken), companyCache.delete(companyId)]);
  // Proxy's update response shape is not relied on; re-read the record.
  const updated = await getCompanyById(companyId);
  if (!updated) {
    throw rejectedError("proxy did not return the updated company");
  }
  return updated;
}

// The frontend revokes the PAT against proxy directly on logout; our job is
// only to drop the cached identity so a revoked PAT isn't served from cache.
export async function evictProxyAuthToken(proxyAuthToken: string): Promise<void> {
  await identityByPat.delete(proxyAuthToken);
}

// ---------------------------------------------------------------------------
// Admin-key calls for the public email-based deploy-token endpoint — see
// src/services/publicTokenRequest.ts. No PAT exists in that flow, so all of
// these act on the workspace with the server's admin key.

// GET /{ref}/getDetails?user_email= — lookup by email. Same envelope as
// getUserById. `null` when unknown (or on an unexpected shape, logged).
export async function getUserByEmail(email: string): Promise<ProxyUser | null> {
  const params = new URLSearchParams({ user_email: email });
  const body = await adminRequest<RawUser>(`/getDetails?${params}`);
  if (body.hasError) {
    throw rejectedError(`proxy refused getDetails by email: ${body.message ?? "unknown"}`);
  }
  // Fail closed: only a row whose email matches counts, whatever the shape.
  const rows = body.data?.data;
  if (!Array.isArray(rows)) return null;
  return rows.map(toUser).find((u) => u?.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

export interface CreatedUserAndCompany {
  user: ProxyUser;
  company: ProxyCompany;
  isNewUser: boolean;
  isNewCompany: boolean;
}

// POST /{ref}/createCUsers?feature_id= (docs/create-user-and-company.md).
// Proxy matches an existing user by Cuser.email and an existing company by
// EXACT company.name — so callers must pass a name that is unique per user
// (the email itself), or a stranger could be linked into someone else's
// company. Returns is_new_* so the caller can assert its expectation.
export async function createUserWithCompany(input: {
  email: string;
  name?: string;
  companyName: string;
}): Promise<CreatedUserAndCompany> {
  const params = new URLSearchParams({ feature_id: PROXY_USER_REFERENCE_ID });
  // Single-object envelope (like createCompany), so the list-shaped generic
  // on adminRequest doesn't apply — cast once at the boundary.
  const body = (await adminRequestWithoutRefId(`/createCUsers?${params}`, {
    method: "POST",
    body: JSON.stringify({
      Cuser: { email: input.email, ...(input.name ? { name: input.companyName } : {}) },
      company: { name: input.companyName },
      role_id: 2
    }),
  })) as ProxySingleEnvelope<{
    user?: RawUser;
    company?: RawCompany;
    is_new_user?: boolean;
    is_new_company?: boolean;
  }>;

  if (body.hasError) {
    throw rejectedError(`proxy refused createCUsers: ${body.message ?? "unknown"}`);
  }
  const user = toUser(body.data?.user);
  const company = toCompany(body.data?.company);
  if (!user || !company) {
    throw rejectedError("proxy did not return both user and company from createCUsers");
  }
  await Promise.all([userCache.delete(user.id), companyCache.delete(company.id)]);
  return {
    user,
    company,
    isNewUser: body.data?.is_new_user === true,
    isNewCompany: body.data?.is_new_company === true,
  };
}

// Every company in the workspace, paged. Stopgap building block for
// listCompaniesForUser until proxy exposes a per-user admin listing.
async function listAllCompanies(): Promise<ProxyCompany[]> {
  const pageSize = 100;
  const out: ProxyCompany[] = [];
  for (let pageNo = 1; pageNo <= 1000; pageNo++) {
    const params = new URLSearchParams({ pageNo: String(pageNo), itemsPerPage: String(pageSize) });
    const body = await adminRequest<RawCompany>(`/getCompanies?${params}`);
    if (body.hasError) {
      throw rejectedError(`proxy refused getCompanies: ${body.message ?? "unknown"}`);
    }
    const page = (body.data?.data ?? []).map(toCompany).filter((c): c is ProxyCompany => c !== null);
    out.push(...page);
    const total = Number(body.data?.totalEntityCount);
    const done = page.length < pageSize || (Number.isFinite(total) && out.length >= total);
    if (done) break;
  }
  return out;
}

// Companies `userId` belongs to, using only the admin key: list every
// company, then ask membership for each (bounded concurrency). O(companies)
// per call — acceptable for now; swap the body for the per-user endpoint
// when proxy ships it. A membership check failing propagates (no partial
// answers) so the caller never mails a subset believing it is the whole.
export async function listCompaniesForUser(userId: string): Promise<ProxyCompany[]> {
  const all = await listAllCompanies();
  const member: ProxyCompany[] = [];
  const concurrency = 5;
  for (let i = 0; i < all.length; i += concurrency) {
    const batch = all.slice(i, i + concurrency);
    const flags = await Promise.all(batch.map((c) => isCompanyMember(userId, c.id)));
    member.push(...batch.filter((_, idx) => flags[idx]));
  }
  return member;
}
