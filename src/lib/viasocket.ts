/**
 * Client for viasocket's partner API — the engine behind the Integrations
 * feature (docs/integrations.md). Embarko is an approved SSO partner, so
 * one signed token creates a customer's workspace, creates a user in it,
 * and logs that user in.
 *
 * This file is the ONLY place that knows viasocket exists at the network
 * level. Everything above it speaks in Embarko's words: a "workspace" here
 * is what viasocket's own docs call an org, and callers never see a
 * viasocket URL, key or session.
 *
 * Secrets:
 *   VIASOCKET_PARTNER_KEY — signs every SSO token. Account-wide: anyone
 *     holding it can sign in as any email under Embarko's workspace.
 *     Server-side only, never logged, never returned by any endpoint. A
 *     leak is a rotate-now event, same as PROXY_ADMIN_TOKEN.
 *   the session token an SSO login returns — used for the API calls that
 *     follow (embed project, org key) and never stored.
 *   each workspace's own auth key (orgAuthKey) — stored, and handed to the
 *     workspace's apps as an env var so they can mint embed tokens.
 *
 * Errors fail closed and carry a public message, like msg91.ts's
 * ProxyError, so routes need no try/catch and errorHandler can answer for
 * them. No viasocket detail reaches the customer: a 403 "not an approved
 * partner" is an Embarko configuration problem, not something a member did.
 */
import crypto from "node:crypto";
import {
  INTEGRATIONS_SSO_TOKEN_TTL_S,
  VIASOCKET_API_BASE,
  VIASOCKET_APP_BASE,
  VIASOCKET_PARENT_ORG_ID,
  VIASOCKET_PARTNER_KEY,
} from "./integrationsConfig";
import { logger } from "./logger";

// Mirrors ProxyError: status + a message safe to show a customer. `code`
// lets callers branch; everyone else can let errorHandler answer.
export class ViasocketError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly code?: string
  ) {
    super(message);
  }
}

// Everything viasocket can go wrong with collapses to one customer-facing
// outcome: Integrations is not answering right now. The detail goes to the
// log, where an operator can act on it.
function unavailable(detail: string, code = "integrations_unavailable"): ViasocketError {
  return new ViasocketError(
    `viasocket: ${detail}`,
    502,
    "Integrations isn't responding right now. Try again in a moment.",
    code
  );
}

// The workspace title Embarko asks viasocket for. Derived from the
// workspace id, NEVER its display name: viasocket makes a new workspace for
// any title it has not seen, so a renamed company whose title followed the
// name would silently get a second, empty workspace and lose its flows.
// Company ids are opaque and immutable, which is exactly what is needed.
export function workspaceTitleFor(companyId: string): string {
  return `Embarko-${companyId}`;
}


export interface SsoTokenInput {
  email: string;
  title: string;
  // Override only for tests; production uses the configured TTL.
  expSeconds?: number;
}

// An HS256 JWT carrying exactly what viasocket's SSO login reads. Short
// lived on purpose: it travels in a query string, which browsers keep in
// history and intermediaries log.
export function signSsoToken({ email, title, expSeconds = INTEGRATIONS_SSO_TOKEN_TTL_S }: SsoTokenInput): string {
  if (!VIASOCKET_PARTNER_KEY || !VIASOCKET_PARENT_ORG_ID) {
    throw new ViasocketError(
      `${!VIASOCKET_PARTNER_KEY ? "VIASOCKET_PARTNER_KEY" : "VIASOCKET_PARENT_ORG_ID"} is not set`,
      503,
      "Integrations isn't set up on this environment yet.",
      "integrations_not_configured"
    );
  }
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      parent_company_id: VIASOCKET_PARENT_ORG_ID,
      email,
      title,
      exp: Math.floor(Date.now() / 1000) + expSeconds,
    })
  );
  const signature = base64Url(
    crypto.createHmac("sha256", VIASOCKET_PARTNER_KEY).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

// HS256 by hand rather than through a JWT library: this is the only JWT
// this service signs for an outside party, the claim set is fixed and
// tiny, and the repo has no typed jwt dependency. Matches the signing the
// Embarko-viasocket prototype verified against viasocket.
function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}


export interface SsoLoginResult {
  // viasocket's `company_id`: the workspace's id, and what its own API
  // calls <org_id>. Stored by Embarko as the mapping for a company.
  workspaceId: string;
  // viasocket's `org_id`: the workspace's NAME, "<parent org>-Embarko-<id>".
  // Kept for support ("which workspace is this customer's?"), not used as
  // an identifier.
  workspaceName: string;
  userId: string;
  // A viasocket session for the API calls that follow. Never stored.
  sessionToken: string;
}

// Exchanges a signed SSO token for a session. This single call does three
// things on viasocket's side: creates the workspace if its title is new,
// creates the user if the email is new to it, and logs that user in.
//
// Which means it is also the provisioning call, and the reason
// services/integrationsWorkspace.ts serialises first use per workspace:
// viasocket documents idempotence for a workspace and user that already
// exist, not for two simultaneous creates of the same new title.
export async function ssoLogin(ssoToken: string): Promise<SsoLoginResult> {
  const url = `${VIASOCKET_API_BASE}/users/sso/login?token=${encodeURIComponent(ssoToken)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw unavailable(`SSO login unreachable: ${(err as Error)?.message}`);
  }

  // The body is read before the status is judged: viasocket puts the
  // reason in `message`, and an operator debugging a 403 needs it.
  const body = (await response.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: Record<string, unknown> }
    | null;

  if (!response.ok || body?.success === false) {
    const detail = body?.message || `status ${response.status}`;
    // 403 means Embarko's own workspace is not an approved SSO partner,
    // and 401 means the partner key is wrong, expired or never created.
    // Both are our configuration, not the member's doing, so they are
    // logged loudly and shown as a generic outage.
    logger.error(`[viasocket] SSO login failed (${response.status}): ${detail}`);
    throw unavailable(`SSO login failed (${response.status}): ${detail}`);
  }

  const data = body?.data ?? {};
  const workspaceId = data.company_id === undefined || data.company_id === null ? "" : String(data.company_id);
  const userId = data.user_id === undefined || data.user_id === null ? "" : String(data.user_id);
  const sessionToken = typeof data.token === "string" ? data.token : "";

  // Fails closed, like msg91.ts's parsing: a workspace row written from a
  // half-understood response would be worse than an error, since every
  // later login for that company trusts the stored id.
  if (!workspaceId || !userId) {
    logger.error("[viasocket] SSO login answered without company_id/user_id");
    throw unavailable("SSO login response missing company_id or user_id");
  }

  return {
    workspaceId,
    workspaceName: typeof data.org_id === "string" ? data.org_id : "",
    userId,
    sessionToken,
  };
}

// One authenticated call against viasocket's API as the session's user.
// Same failure shape as ssoLogin: anything wrong is an outage to the
// customer and a detailed line in the log.
async function api<T>(
  session: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${VIASOCKET_API_BASE}${path}`, {
      method,
      headers: {
        accept: "application/json",
        proxy_auth_token: session,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw unavailable(`${method} ${path} unreachable: ${(err as Error)?.message}`);
  }
  const parsed = (await response.json().catch(() => null)) as { success?: boolean; message?: string; data?: T } | null;
  if (!response.ok || parsed?.success === false || parsed?.data === undefined) {
    const detail = parsed?.message || `status ${response.status}`;
    logger.error(`[viasocket] ${method} ${path} failed: ${detail}`);
    throw unavailable(`${method} ${path} failed: ${detail}`);
  }
  return parsed.data;
}

export interface EmbedProject {
  id: string;
  title: string;
}

// The workspace's embed projects. Checked before creating one, since
// viasocket makes a new project per POST. The reply's data is
// `{projects: [...], flows: [...]}` (verified live 2026-10-24); a bare
// array is accepted too in case that changes.
export async function listEmbedProjects(orgId: string, session: string): Promise<EmbedProject[]> {
  const data = await api<unknown>(session, "GET", `/orgs/${encodeURIComponent(orgId)}/projects?type=embed`);
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { projects?: unknown }).projects)
      ? (data as { projects: unknown[] }).projects
      : [];
  if (!Array.isArray(data) && rows.length === 0) logger.warn("[viasocket] project list answered with no projects array");
  return rows
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => !!r && r.id !== undefined && r.id !== null)
    .map((r) => ({ id: String(r.id), title: typeof r.title === "string" ? r.title : "" }));
}

// viasocket's dashboard defaults for an embed project; the embed can
// override them at load time.
const EMBED_PROJECT_SETTINGS = {
  serviceType: "trigger",
  serviceName: "webhook",
  serviceId: "webhook",
  permittedEvents: "all",
  unpermittedEvents: [],
  response: { status: "notdefined", type: "custom" },
  config: {
    universal: true,
    appsApi: true,
    buttonName: "Integrations",
    buttonType: "custom",
    height: "100",
    heightUnit: "%",
    width: "100",
    widthUnit: "%",
    type: "all_space",
    showEnabled: true,
    showServices: true,
    filterTrigger: false,
    filterAction: false,
    directFlow: false,
    chatbot: false,
    featuredCombinations: {},
    featuredCombinationType: "default",
    filteredServices: {},
    categories: [],
  },
};

export async function createEmbedProject(orgId: string, session: string, title: string): Promise<EmbedProject> {
  const data = await api<Record<string, unknown>>(session, "POST", `/orgs/${encodeURIComponent(orgId)}/projects`, {
    title: title.slice(0, 50),
    type: "embed",
    settings: EMBED_PROJECT_SETTINGS,
  });
  if (data?.id === undefined || data?.id === null) {
    logger.error("[viasocket] create project answered without id");
    throw unavailable("create project response missing id");
  }
  return { id: String(data.id), title };
}

// The workspace's own auth key. Created on the first call, the same key
// after; it signs the embed tokens the workspace's apps mint.
export async function orgAuthKey(orgId: string, session: string): Promise<string> {
  const data = await api<unknown>(session, "GET", `/orgs/${encodeURIComponent(orgId)}/token`);
  if (typeof data !== "string" || !data) {
    logger.error("[viasocket] org token answered without a key");
    throw unavailable("org token response missing key");
  }
  return data;
}

// Where a member's browser lands inside viasocket, already signed in: the
// workspace's integrations page, or one app's embed metrics. `session` is
// the token an SSO login returned for THAT member; it is the credential,
// so the URL is handed to one browser once and never stored or logged.
export function consoleUrl(orgId: string, session: string, embedProjectId?: string): string {
  const base = `${VIASOCKET_APP_BASE}/integrations/${encodeURIComponent(orgId)}`;
  const path = embedProjectId ? `${base}/${encodeURIComponent(embedProjectId)}/embed-metrics` : base;
  return `${path}?proxy_auth_token=${encodeURIComponent(session)}`;
}
