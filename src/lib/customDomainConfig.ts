/**
 * Config specific to the custom-domains feature — see
 * docs/Customdomain-req.md. Fail-fast at startup, same convention as
 * src/lib/msg91.ts, rather than failing confusingly on the first request
 * that needs one of these.
 */
import psl from "psl";
import { isPlatformDomain } from "./customDomain";
import { logger } from "./logger";

if (!process.env.EDGE_HOSTNAME) {
  throw new Error(
    "EDGE_HOSTNAME environment variable is not set. This must be a dedicated, " +
      "permanently-unproxied hostname (e.g. edge.hostnsoft.com) resolving directly " +
      "to the origin server's IP — see docs/Customdomain-req.md constraint #2. " +
      "Never reuse the proxied *.app.<platform-domain> hostname here."
  );
}
export const EDGE_HOSTNAME: string = process.env.EDGE_HOSTNAME;

if (!process.env.ORIGIN_SERVER_IP) {
  throw new Error(
    "ORIGIN_SERVER_IP environment variable is not set. This is the origin server's " +
      "real IP, used for apex-domain A-record instructions and verification."
  );
}
export const ORIGIN_SERVER_IP: string = process.env.ORIGIN_SERVER_IP;

/**
 * The platform's own registrable domain — the zone a customer must never be
 * able to register a "custom" domain inside.
 *
 * Without this, `verifyDomainDns`'s IP-match fallback is enough to claim a
 * platform hostname: any name in this zone that resolves to the origin
 * matches the same IP as EDGE_HOSTNAME, so verification passes and Traefik
 * gets a router for it pointing at the customer's app. Today that reaches
 * EDGE_HOSTNAME itself; once apps move to <slug>.<domain> it would be a way
 * around the reserved-name list entirely.
 *
 * Derived from EDGE_HOSTNAME rather than adding a required env var —
 * EDGE_HOSTNAME is already mandatory above and is always `edge.<zone>` by
 * convention, and psl resolves the registrable domain correctly even for
 * multi-part suffixes. PLATFORM_DOMAIN overrides it where that convention
 * doesn't hold.
 */
export const PLATFORM_DOMAIN: string = (() => {
  const override = process.env.PLATFORM_DOMAIN?.toLowerCase().trim();
  if (override) return override;
  const parsed = psl.parse(EDGE_HOSTNAME.toLowerCase());
  if ("error" in parsed || !parsed.domain) {
    throw new Error(
      `Could not derive the platform domain from EDGE_HOSTNAME ("${EDGE_HOSTNAME}"). ` +
        "Set PLATFORM_DOMAIN explicitly — custom-domain registration is refused " +
        "inside the platform's own zone and that check can't be skipped."
    );
  }
  return parsed.domain;
})();

// Say out loud, at boot, which zone is actually being protected.
//
// This guard fails silently when it's wrong: a typo'd PLATFORM_DOMAIN
// matches nothing, every check passes, and registration of a platform
// hostname succeeds with a normal 201 — indistinguishable from the guard
// not existing. Confirmed the hard way, by a value copied out of
// .env.example landing in a real .env.
//
// EDGE_HOSTNAME is a platform hostname by definition, so it should sit
// inside the platform zone. A warning rather than a throw: splitting the
// edge host onto a separate domain is a legitimate (if unusual) setup, and
// refusing to boot over it would be worse than saying so clearly.
if (isPlatformDomain(EDGE_HOSTNAME, PLATFORM_DOMAIN)) {
  logger.info(`[customDomainConfig] custom domains refused inside "${PLATFORM_DOMAIN}"`);
} else {
  logger.warn(
    `[customDomainConfig] PLATFORM_DOMAIN is "${PLATFORM_DOMAIN}" but EDGE_HOSTNAME ` +
      `"${EDGE_HOSTNAME}" is outside it. If that isn't deliberate, PLATFORM_DOMAIN is ` +
      `wrong and the platform zone is NOT being protected — a customer could register ` +
      `a platform hostname as a custom domain.`
  );
}

// How often previously-verified domains get re-checked against live DNS —
// see docs/Customdomain-req.md constraint #3 ("re-checked periodically
// after activation ... don't continue serving or attempting to renew
// certificates for a domain that no longer points here"). Defaults to
// daily; overridable for testing.
export const DOMAIN_REVERIFICATION_INTERVAL_MS: number = process.env
  .DOMAIN_REVERIFICATION_INTERVAL_MS
  ? Number(process.env.DOMAIN_REVERIFICATION_INTERVAL_MS)
  : 24 * 60 * 60 * 1000;
