/**
 * Confirms a custom domain's live DNS actually points at the platform —
 * see docs/Customdomain-req.md constraint #3. Never activate routing or
 * request a certificate without this passing first, and re-check it on
 * an ongoing schedule after activation (src/services/domainReverification.ts).
 *
 * Fails closed: any lookup error (NXDOMAIN, timeout, no records) counts
 * as "not verified" rather than throwing — a broken/unset-up domain is
 * the expected, common case here, not an exceptional one.
 */
import { promises as dns } from "node:dns";
import { type DomainType } from "./customDomain";
import { EDGE_HOSTNAME, ORIGIN_SERVER_IP, platformZoneOf } from "./customDomainConfig";
import { logger } from "./logger";

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

async function subdomainPointsAtEdge(domain: string): Promise<boolean> {
  // Preferred: an explicit CNAME record naming our dedicated edge host.
  try {
    const cnames = await dns.resolveCname(domain);
    if (cnames.some((c) => normalizeHostname(c) === normalizeHostname(EDGE_HOSTNAME))) {
      return true;
    }
  } catch {
    // No CNAME record retrievable (some resolvers/providers flatten it,
    // or it simply isn't set up) — fall through to the IP-match check
    // below rather than treating this alone as failure.
  }

  // Fallback: whatever the domain resolves to should land on the same IP
  // as our edge host does, even if the CNAME chain itself wasn't directly
  // readable above.
  try {
    const [domainIps, edgeIps] = await Promise.all([
      dns.resolve4(domain),
      dns.resolve4(EDGE_HOSTNAME),
    ]);
    return domainIps.some((ip) => edgeIps.includes(ip));
  } catch (e) {
    logger.warn(`[dnsVerify] could not resolve "${domain}" (or edge host) as a subdomain: ${(e as Error).message}`);
    return false;
  }
}

async function apexPointsAtOrigin(domain: string): Promise<boolean> {
  try {
    const ips = await dns.resolve4(domain);
    return ips.includes(ORIGIN_SERVER_IP);
  } catch (e) {
    logger.warn(`[dnsVerify] could not resolve "${domain}" as an apex domain: ${(e as Error).message}`);
    return false;
  }
}

export async function verifyDomainDns(domain: string, type: DomainType): Promise<boolean> {
  // Refused here rather than only at registration, so every caller inherits
  // it: the verify endpoint, the periodic re-verification sweep, and
  // anything added later. A name in our own zone would otherwise pass on
  // the origin-IP fallback below, since that's exactly where it points.
  //
  // This also cleans up after itself. Any such domain registered before
  // this check existed is `active` today; the next re-verification pass
  // sees false and deactivates it, with no migration to write.
  const platformZone = platformZoneOf(domain);
  if (platformZone) {
    logger.warn(
      `[dnsVerify] refusing "${domain}": inside the platform zone ${platformZone}, never a valid custom domain`
    );
    return false;
  }
  return type === "apex" ? apexPointsAtOrigin(domain) : subdomainPointsAtEdge(domain);
}
