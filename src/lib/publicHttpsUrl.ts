/**
 * Guards a URL a customer gave us that this service will then call itself
 * (today: a schedule's alert webhook). Without it, "alert me at
 * https://127.0.0.1:4100/internal/..." turns the API into a proxy onto its
 * own host and private network.
 *
 * Checked on save AND again right before each call, since what a hostname
 * resolves to can change after it was accepted.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast + reserved
  );
}

function isPrivateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
  if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true; // link-local
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateV4(mapped[1]) : false;
}

function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 4 ? isPrivateV4(ip) : isPrivateV6(ip);
}

// Syntax only — what can be checked without the network.
export function parsePublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Not a valid URL.");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("Must be an https:// URL.");
  if (url.username || url.password) throw new UnsafeUrlError("Must not contain a username or password.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("Must point at a public host.");
  }
  if (isIP(host) && isPrivateAddress(host)) throw new UnsafeUrlError("Must point at a public host.");
  return url;
}

// Syntax plus DNS: every address the host resolves to must be public.
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = parsePublicHttpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return url;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`"${host}" does not resolve.`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError("Must point at a public host.");
  }
  return url;
}
