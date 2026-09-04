/**
 * Config specific to the custom-domains feature — see
 * docs/Customdomain-req.md. Fail-fast at startup, same convention as
 * src/lib/msg91.ts, rather than failing confusingly on the first request
 * that needs one of these.
 */

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

// How often previously-verified domains get re-checked against live DNS —
// see docs/Customdomain-req.md constraint #3 ("re-checked periodically
// after activation ... don't continue serving or attempting to renew
// certificates for a domain that no longer points here"). Defaults to
// daily; overridable for testing.
export const DOMAIN_REVERIFICATION_INTERVAL_MS: number = process.env
  .DOMAIN_REVERIFICATION_INTERVAL_MS
  ? Number(process.env.DOMAIN_REVERIFICATION_INTERVAL_MS)
  : 24 * 60 * 60 * 1000;
