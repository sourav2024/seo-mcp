/**
 * URL validation and host-safety checks.
 *
 * Two jobs:
 *   1. Validate/normalize user input before it reaches fetch() — reject
 *      non-HTTP schemes, malformed input, and absurd lengths.
 *   2. Optionally block private/loopback/link-local targets (SSRF defense),
 *      re-checked after every redirect hop since a public host can redirect
 *      to 169.254.169.254 or 127.0.0.1.
 *
 * Private hosts are ALLOWED by default: auditing localhost:3000 or an internal
 * staging site is a primary local use case. Set SEO_MCP_ALLOW_PRIVATE_HOSTS=false
 * when exposing this server to untrusted input.
 */
import { promises as dns } from "node:dns";
import { config } from "./config.js";

const MAX_URL_LENGTH = 2048;

/** Thrown for invalid or disallowed URLs; carries a user-facing message. */
export class UrlValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "UrlValidationError";
  }
}

/**
 * Add a scheme when the user omitted it ("example.com" → "https://example.com").
 * Kept permissive because MCP users type bare hostnames constantly.
 */
export function normalizeUrl(url) {
  if (typeof url !== "string") throw new UrlValidationError("URL must be a string.");
  const trimmed = url.trim();
  if (!trimmed) throw new UrlValidationError("URL must not be empty.");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Parse a URL, raising UrlValidationError instead of a bare TypeError.
 *
 * Checks call this rather than `new URL(normalizeUrl(x))` so that a malformed
 * input produces an actionable message through describeError(). The MCP layer
 * validates first, but the checks are also importable as a library — where an
 * unhandled TypeError would be a poor contract.
 */
export function parseUrlOrThrow(url, { context = "URL" } = {}) {
  return assertFetchableUrl(url, { context });
}

/* ---------------- Private-range detection ---------------- */

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const IPV4_BLOCKS = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // RFC6598 carrier NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return IPV4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function isPrivateIpv6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true; // unspecified / loopback
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  // IPv4-mapped (::ffff:127.0.0.1) — unwrap and check as IPv4.
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  // The same mapping in hex form (::ffff:7f00:1), which is how the WHATWG URL
  // parser serializes it — "[::ffff:127.0.0.1]" arrives here as "::ffff:7f00:1".
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = parseInt(hex[1], 16) * 65536 + parseInt(hex[2], 16);
    return isPrivateIpv4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  return false;
}

/** Hostnames that resolve to the local machine or an internal network by convention. */
const PRIVATE_HOSTNAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i;

/**
 * Whether a hostname could plausibly resolve.
 *
 * The WHATWG URL parser is far more permissive than DNS — it happily accepts
 * "ht!tp" as a host when a mistyped scheme collapses into one. IPv6 literals
 * (already bracket-wrapped by the parser) and IDN punycode are allowed through.
 */
function isValidHostname(hostname) {
  if (hostname.startsWith("[")) return /^\[[0-9a-f:.]+\]$/i.test(hostname); // IPv6 literal
  if (hostname.length > 253) return false;
  // Labels: alphanumerics and hyphens, no leading/trailing hyphen, no empty labels.
  return hostname
    .replace(/\.$/, "")
    .split(".")
    .every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label));
}

/** True when the host is loopback, private, link-local, or a local-only name. */
export function isPrivateHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (PRIVATE_HOSTNAMES.test(h)) return true;
  if (h.includes(":") || /^\[/.test(h)) return isPrivateIpv6(h);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIpv4(h);
  // Bare hostname with no dot (e.g. "intranet") — resolvable only inside a network.
  if (!h.includes(".")) return true;
  return false;
}

/**
 * Validate a URL for fetching. Returns a parsed URL object.
 * @param {string} url
 * @param {{ context?: string }} [opts] context appears in the error message
 */
export function assertFetchableUrl(url, { context = "URL" } = {}) {
  const normalized = normalizeUrl(url);
  if (normalized.length > MAX_URL_LENGTH)
    throw new UrlValidationError(`${context} exceeds ${MAX_URL_LENGTH} characters.`);

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new UrlValidationError(`${context} is not a valid URL: "${String(url).slice(0, 120)}"`);
  }

  // Only http(s). Blocks file:, data:, gopher:, ftp:, jar: and similar.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new UrlValidationError(
      `${context} must use http:// or https:// (got "${parsed.protocol}"). Only web pages can be audited.`
    );

  if (!parsed.hostname) throw new UrlValidationError(`${context} has no hostname.`);

  // The URL parser accepts hostnames DNS never will ("ht!tp" from a mistyped
  // scheme), which would otherwise surface later as an opaque "fetch failed".
  if (!isValidHostname(parsed.hostname))
    throw new UrlValidationError(
      `${context} has an invalid hostname ("${parsed.hostname}"). Check the scheme and spelling — ` +
        `hostnames may contain only letters, digits, hyphens, and dots.`
    );

  if (!config.allowPrivateHosts && isPrivateHost(parsed.hostname))
    throw new UrlValidationError(
      `${context} points at a private or loopback address ("${parsed.hostname}"), which is blocked because ` +
        `SEO_MCP_ALLOW_PRIVATE_HOSTS=false. Unset it to audit localhost or internal hosts.`
    );

  return parsed;
}

/** Whether a string is an IP literal (IPv4 dotted quad or IPv6, bracketed or not). */
function isIpLiteral(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * Resolve a hostname and reject it when any address it resolves to is private.
 *
 * The synchronous checks above only see the hostname, so a public name whose DNS
 * points at 127.0.0.1 or 169.254.169.254 would pass them. This closes that gap
 * by checking every resolved address before the request is made. It is a no-op
 * while private hosts are allowed (the default), so local use pays no DNS cost.
 *
 * Residual risk: the check and fetch()'s own connect resolve separately, so a
 * DNS server answering with a TTL of 0 can still swap the address in between
 * (DNS rebinding). See SECURITY.md.
 *
 * @param {string} url
 * @param {{ allowPrivate?: boolean, lookup?: Function, context?: string }} [opts]
 *   lookup is injectable for tests; it must behave like dns.promises.lookup.
 */
export async function assertResolvesPublic(
  url,
  { allowPrivate = config.allowPrivateHosts, lookup = dns.lookup, context = "URL" } = {}
) {
  if (allowPrivate) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) return; // literals were already checked by assertFetchableUrl
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return; // unresolvable: fetch() will fail with its own, clearer DNS error
  }
  const bad = addresses.find(({ address }) => isPrivateHost(address));
  if (bad)
    throw new UrlValidationError(
      `${context} host "${host}" resolves to a private address (${bad.address}), which is blocked because ` +
        `SEO_MCP_ALLOW_PRIVATE_HOSTS=false.`
    );
}

/**
 * Guard a redirect target. A public URL can redirect into a private range, so
 * every hop must be re-validated rather than trusting the initial check.
 */
export function assertRedirectTarget(location, base) {
  let next;
  try {
    next = new URL(location, base);
  } catch {
    throw new UrlValidationError(`Redirect target is not a valid URL: "${String(location).slice(0, 120)}"`);
  }
  if (next.protocol !== "http:" && next.protocol !== "https:")
    throw new UrlValidationError(`Redirect to a non-HTTP scheme ("${next.protocol}") was blocked.`);
  if (!config.allowPrivateHosts && isPrivateHost(next.hostname))
    throw new UrlValidationError(
      `Redirect to a private address ("${next.hostname}") was blocked by SEO_MCP_ALLOW_PRIVATE_HOSTS=false.`
    );
  return next;
}
