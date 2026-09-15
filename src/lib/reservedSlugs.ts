/**
 * App names nobody may claim, and the shape rules a name must satisfy.
 *
 * An app's slug IS its hostname. While apps live at <slug>.app.<zone> a
 * claimed name can only ever shadow another app; once they move to
 * <slug>.<zone> the same name becomes a platform hostname, and claiming
 * `ship` would emit a Traefik router for the deploy API's own host — the
 * endpoint agents POST source and deploy tokens to. That is the reason
 * this file exists, so it must land BEFORE that move.
 *
 * Deliberately a code constant rather than a database table. It's a
 * security control: in code it's diffable, reviewed in a PR, deployed
 * atomically with the change that needs it, and impossible to empty with
 * a stray DELETE. It also changes rarely, so "needs a deploy to edit"
 * costs almost nothing.
 *
 * Applies to NEW claims only — see projectClaim.ts. An app already
 * holding one of these keeps working; the check asks whether the project
 * exists before refusing, so nothing live breaks when this ships.
 */

// Router names and hostnames already in use. Claiming one of these is the
// direct takeover case.
const INFRASTRUCTURE = [
  "ship", "edge", "api", "app", "apps", "www", "admin", "dashboard", "console",
];

// server-setup.sh builds env-segmented hostnames like ship.test.<zone>, so
// these must never be a first label either.
const ENVIRONMENTS = [
  "test", "demo", "staging", "stage", "dev", "prod", "production", "preview",
  "sandbox", "beta", "alpha", "internal", "local", "localhost",
];

// Claiming these lets someone receive or impersonate platform mail, and
// breaks deliverability for the real zone.
const MAIL_AND_DNS = [
  "mail", "smtp", "imap", "pop", "pop3", "mx", "webmail", "email", "ns", "ns1",
  "ns2", "ns3", "ns4", "dns", "autodiscover", "autoconfig", "spf", "dkim", "dmarc",
];

// Certificate issuance and domain-control validation.
const TLS = ["acme", "acme-challenge", "well-known", "wellknown", "cert", "certs", "ca"];

// Highest phishing value on the whole list: a page at login.<zone> with a
// real certificate is indistinguishable from the platform's own.
const AUTH_AND_PAYMENT = [
  "login", "signin", "sign-in", "signup", "sign-up", "register", "logout",
  "auth", "oauth", "sso", "account", "accounts", "token", "tokens", "billing",
  "pay", "payment", "payments", "checkout", "stripe", "invoice", "invoices",
];

// Names a user would reasonably read as "the platform speaking".
const BRAND_AND_TRUST = [
  "embarko", "support", "help", "docs", "doc", "documentation", "status",
  "security", "abuse", "legal", "terms", "privacy", "dpa", "contact", "sales",
  "about", "careers", "jobs", "blog", "news", "press", "showcase", "pricing",
];

// Not in use yet. Reserved so shipping any of them later doesn't require
// taking a name back off a customer.
const PLATFORM_FUTURE = [
  "cdn", "assets", "static", "media", "files", "uploads", "storage", "s3",
  "db", "database", "redis", "cache", "queue", "logs", "metrics", "grafana",
  "prometheus", "nomad", "traefik", "consul", "vault", "webhook", "webhooks",
  "callback", "callbacks", "proxy", "gateway", "registry", "git", "ci",
  "build", "deploy", "deployments", "skills", "llms", "mcp",
];

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...INFRASTRUCTURE,
  ...ENVIRONMENTS,
  ...MAIL_AND_DNS,
  ...TLS,
  ...AUTH_AND_PAYMENT,
  ...BRAND_AND_TRUST,
  ...PLATFORM_FUTURE,
]);

// Shortest claimable name. Reserves the 1-2 character space rather than
// letting it be squatted, and those are the names most worth keeping.
export const MIN_SLUG_LENGTH = 3;

// A DNS label cannot exceed 63 octets. Nothing enforced this before, so a
// longer name produced an unroutable hostname only discovered at deploy.
export const MAX_SLUG_LENGTH = 63;

export type SlugRejection = { reserved: true; reason: string; code: string };
export type SlugCheck = { reserved: false } | SlugRejection;

/**
 * Why a name can't be used, or that it can. The reason is returned to the
 * caller verbatim — an agent that's told "reserved" and nothing else will
 * retry variations blindly, where one told why picks a different name.
 */
export function checkSlug(slug: string): SlugCheck {
  const s = slug.toLowerCase();

  if (s.length < MIN_SLUG_LENGTH) {
    return {
      reserved: true,
      code: "app_name_too_short",
      reason: `App names must be at least ${MIN_SLUG_LENGTH} characters.`,
    };
  }

  if (s.length > MAX_SLUG_LENGTH) {
    return {
      reserved: true,
      code: "app_name_too_long",
      reason: `App names must be at most ${MAX_SLUG_LENGTH} characters — the name becomes a DNS label.`,
    };
  }

  // `-foo` and `foo-` are not valid DNS labels, and the slug regex
  // elsewhere (^[a-z0-9-]+$) allows both.
  if (s.startsWith("-") || s.endsWith("-")) {
    return {
      reserved: true,
      code: "invalid_app_name",
      reason: "App names can't start or end with a hyphen — the name becomes a DNS label.",
    };
  }

  // Punycode. A name rendering as a lookalike of a platform hostname is
  // exactly what the rest of this file is preventing.
  if (s.startsWith("xn--")) {
    return {
      reserved: true,
      code: "app_name_reserved",
      reason: "Internationalised (xn--) app names aren't available.",
    };
  }

  if (RESERVED_SLUGS.has(s)) {
    return {
      reserved: true,
      code: "app_name_reserved",
      reason: `"${s}" is reserved by the platform. Pick a different name.`,
    };
  }

  return { reserved: false };
}
