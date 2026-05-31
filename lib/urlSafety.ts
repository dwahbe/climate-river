// lib/urlSafety.ts
// SSRF protection for server-side fetches of arbitrary (often LLM/RSS-sourced)
// article URLs. Validates scheme + host, resolves DNS, and rejects any hop that
// points at private/loopback/link-local/metadata address space — including via
// 30x redirects (the reader and discovery paths previously used redirect:"follow"
// with no validation, which a single redirect could turn into a metadata-endpoint
// read).

import { lookup } from "node:dns/promises";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(ip: string): number | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const octets = m.slice(1, 5).map((o) => Number(o));
  if (octets.some((o) => o < 0 || o > 255)) return null;
  return (
    ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]
  );
}

function inCidr(ipInt: number, baseIp: string, prefix: number): boolean {
  const base = ipv4ToInt(baseIp);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

// Private / loopback / link-local / reserved IPv4 ranges (RFC 1918, 5735, 6598, …).
const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. 169.254.169.254 metadata)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved / future
];

function isBlockedIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  if (ipInt === 0xffffffff) return true; // 255.255.255.255
  return BLOCKED_IPV4.some(([base, prefix]) => inCidr(ipInt, base, prefix));
}

function isBlockedIpv6(ipRaw: string): boolean {
  const ip = ipRaw.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // IPv4-mapped / -compatible in dotted-quad tail form (e.g. ::ffff:169.254.169.254).
  const mapped = ip.match(/(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // IPv4-mapped in HEX tail form — this is what the WHATWG URL parser actually
  // produces: new URL("http://[::ffff:127.0.0.1]") → hostname "[::ffff:7f00:1]".
  // Decode the trailing two 16-bit groups back into an IPv4 and check it.
  const hexMapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(v4);
  }
  if (ip === "::1" || ip === "::") return true; // loopback / unspecified
  if (
    ip.startsWith("fe8") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb")
  )
    return true; // fe80::/10 link-local
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7 ULA
  if (
    ip.startsWith("fec") ||
    ip.startsWith("fed") ||
    ip.startsWith("fee") ||
    ip.startsWith("fef")
  )
    return true; // fec0::/10 site-local (deprecated)
  if (ip.startsWith("2001:db8")) return true; // documentation
  if (ip.startsWith("ff")) return true; // multicast
  return false;
}

function looksLikeIpv6(host: string): boolean {
  return host.includes(":");
}

/** True if the given IP literal is in private/loopback/link-local/reserved space. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const stripped = ip.replace(/^\[/, "").replace(/\]$/, "");
  if (IPV4_RE.test(stripped)) return isBlockedIpv4(stripped);
  if (looksLikeIpv6(stripped)) return isBlockedIpv6(stripped);
  return false;
}

/**
 * True if a hostname should be blocked outright (special-use names, or literal
 * IPs in reserved ranges). Domain names that need DNS resolution return false
 * here — {@link safeFetch} resolves and re-checks them.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return true;
  if (host === "localhost") return true;
  if (
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (IPV4_RE.test(host) || looksLikeIpv6(host)) {
    return isPrivateOrReservedIp(host);
  }
  return false;
}

/**
 * Parse and validate a URL for server-side fetching. Throws {@link SsrfError}
 * for non-http(s) schemes or blocked hosts. Returns the parsed URL.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError(`Invalid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfError(`Disallowed URL scheme: ${u.protocol}`);
  }
  if (isBlockedHostname(u.hostname)) {
    throw new SsrfError(`Blocked host: ${u.hostname}`);
  }
  return u;
}

export type SafeFetchOptions = {
  maxRedirects?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Resolves a hostname to a list of IP strings. */
  resolveHost?: (hostname: string) => Promise<string[]>;
};

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a URL with SSRF protection: validates the scheme/host, DNS-resolves the
 * host and rejects private/reserved IPs, and follows redirects MANUALLY,
 * re-validating every hop (so a public URL that 30x-redirects to an internal
 * address is still blocked). Throws {@link SsrfError} on a policy block and a
 * plain Error on transient resolution failure.
 *
 * KNOWN RESIDUAL (DNS rebinding / TOCTOU): the connection is not pinned to the
 * validated address — `fetchImpl` re-resolves the hostname independently, so an
 * attacker who controls authoritative DNS for a hostname they get into the
 * pipeline could return a public IP to our `resolveHost` and a private one to
 * the actual fetch. Closing this requires pinning the socket to the validated
 * IP via a custom dispatcher/lookup (undici Agent) — tracked as a follow-up.
 * The literal-IP and redirect-hop paths ARE fully validated.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolveHost = opts.resolveHost ?? defaultResolveHost;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = assertPublicHttpUrl(current);

    // Domain names: resolve and reject if ANY resolved address is private.
    const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    const isLiteralIp = IPV4_RE.test(host) || looksLikeIpv6(host);
    if (!isLiteralIp) {
      let addresses: string[];
      try {
        addresses = await resolveHost(parsed.hostname);
      } catch (err) {
        // Resolution failure is transient/infra, NOT a policy block. Throw a
        // plain Error (not SsrfError) so callers like the discovery reachability
        // check can apply benefit-of-the-doubt instead of dropping the article.
        throw new Error(
          `DNS resolution failed for ${parsed.hostname}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (addresses.length === 0) {
        throw new Error(`No addresses for ${parsed.hostname}`);
      }
      for (const addr of addresses) {
        if (isPrivateOrReservedIp(addr)) {
          throw new SsrfError(
            `${parsed.hostname} resolves to blocked address ${addr}`,
          );
        }
      }
    }

    const response = await fetchImpl(current, { ...init, redirect: "manual" });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) return response;
      current = new URL(location, current).toString();
      continue;
    }

    return response;
  }

  throw new SsrfError(`Too many redirects (>${maxRedirects})`);
}
