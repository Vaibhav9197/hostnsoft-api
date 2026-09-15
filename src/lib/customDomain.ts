/**
 * Apex vs. subdomain classification for custom domains — see
 * docs/Customdomain-req.md "Edge cases" and the DNS instructions section.
 * A CNAME record cannot target a zone apex under standard DNS rules, so
 * apex domains get an A-record instruction instead.
 *
 * Naive dot-counting ("one dot = apex") is wrong for domains under a
 * multi-part public suffix (e.g. "client.co.uk" is itself an apex, not a
 * subdomain of "co.uk") — psl (the Public Suffix List) is what actually
 * knows which suffixes are registrable.
 */
import psl from "psl";

export type DomainType = "apex" | "subdomain";

// Deliberately permissive — real validation is "does it resolve", not
// regex perfection. Just enough to reject obvious garbage before it
// reaches psl/DNS lookups.
const DOMAIN_SYNTAX = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isValidDomainSyntax(domain: string): boolean {
  return DOMAIN_SYNTAX.test(domain);
}

/**
 * Is this domain the platform's own zone, or inside it?
 *
 * Registering one as a "custom domain" would hand a customer a Traefik
 * router for a platform hostname. DNS verification does not stop it: the
 * subdomain check falls back to matching the origin IP, and every name in
 * this zone that points at the origin matches. So it's refused up front,
 * by name, before any DNS is consulted.
 *
 * Matches the zone itself and anything under it at any depth —
 * `embarko.ai`, `ship.embarko.ai` and `a.b.embarko.ai` alike. The
 * endsWith test is anchored on a leading dot so a lookalike registration
 * like `notembarko.ai` isn't caught by accident.
 *
 * Takes the zone as an argument rather than importing it: this module is
 * pure name-handling with no config dependency, and customDomainConfig
 * throws at import time if its env vars are missing, which would drag a
 * startup requirement into anything that only wanted to classify a string.
 */
export function isPlatformDomain(domain: string, platformDomain: string): boolean {
  const lower = domain.toLowerCase().replace(/\.$/, "");
  const zone = platformDomain.toLowerCase().replace(/\.$/, "");
  return lower === zone || lower.endsWith(`.${zone}`);
}

export function classifyDomain(domain: string): DomainType {
  const lower = domain.toLowerCase();
  const parsed = psl.parse(lower);
  // psl.parse can return an error result (e.g. no recognized public
  // suffix) instead of a ParsedDomain — isValidDomainSyntax should have
  // already filtered out anything this malformed, but treat it as a
  // subdomain (the safer default: CNAME instructions, not an A record
  // for something we're not confident is actually an apex).
  if ("error" in parsed) return "subdomain";
  // psl's own `domain` is the registrable apex (e.g. "example.co.uk").
  // If it equals the input, the input IS the apex; anything else (having
  // a `subdomain` part) is a subdomain of it.
  return parsed.domain === lower ? "apex" : "subdomain";
}
