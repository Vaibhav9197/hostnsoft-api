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
