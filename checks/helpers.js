/** Shared fetch, matching, and report helpers used by all checks. */
import { config } from "../src/config.js";
import { log } from "../src/logger.js";
import { VERSION } from "../src/version.js";
import {
  assertFetchableUrl,
  assertRedirectTarget,
  assertResolvesPublic,
  normalizeUrl,
  parseUrlOrThrow,
} from "../src/url-guard.js";

export { VERSION };
export { normalizeUrl, parseUrlOrThrow };

export const UA = `Mozilla/5.0 (compatible; seo-mcp/${VERSION}; +https://github.com/sourav2024/seo-mcp)`;

/** Standard request headers for every audit fetch. */
const FETCH_HEADERS = Object.freeze({ "User-Agent": UA, Accept: "text/html,*/*" });

/** Status codes treated as redirects when walking a chain. */
export const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);

export function text(s) {
  return { content: [{ type: "text", text: s }] };
}

/**
 * Read a response body, stopping at config.maxBodyBytes.
 *
 * The reader is always released, including on the early-exit and error paths —
 * an un-released reader keeps the underlying socket pinned, which leaks
 * connections across a long crawl.
 */
export async function readCapped(res, { maxBytes = config.maxBodyBytes } = {}) {
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) {
    log.debug("Skipping oversized body", { declared, maxBytes, url: res.url });
    await res.body?.cancel?.().catch(() => {});
    return "";
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // cancel() both stops the stream and releases the lock; ignore races where
    // the stream already closed on its own.
    await reader.cancel().catch(() => {});
  }
  if (truncated) log.debug("Body truncated at cap", { maxBytes, url: res.url });
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/**
 * Fetch a URL with validation, a timeout, and per-hop redirect checks.
 *
 * Redirects are followed manually (redirect: "manual") rather than by the
 * platform so every hop passes through assertRedirectTarget — otherwise a
 * public URL could redirect into a private range unchecked. Each hop's resolved
 * addresses are checked too, when private hosts are blocked.
 */
export async function fetchPage(
  url,
  { timeoutMs = config.fetchTimeoutMs, maxHops = config.maxRedirectHops, headers, method } = {}
) {
  let current = assertFetchableUrl(url).href;
  const done = log.timer();

  for (let hop = 0; hop <= maxHops; hop++) {
    await assertResolvesPublic(current);
    const res = await fetch(current, {
      headers: { ...FETCH_HEADERS, ...headers },
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!REDIRECT_STATUSES.includes(res.status)) {
      const body = await readCapped(res);
      log.debug("Fetched page", { url: current, status: res.status, bytes: body.length, ms: done(), hops: hop });
      return { res, body, finalUrl: current };
    }

    const location = res.headers.get("location");
    await res.body?.cancel?.().catch(() => {});
    if (!location) {
      log.debug("Redirect without Location header", { url: current, status: res.status });
      return { res, body: "", finalUrl: current };
    }
    current = assertRedirectTarget(location, current).href;
  }
  throw new Error(`Too many redirects (>${maxHops}) starting from ${url}`);
}

/**
 * Resolve a page for an audit function. Audits accept an optional prefetched
 * `page` ({ body, headers, status, finalUrl }) so crawl_audit can fetch each
 * URL once and share it; direct tool calls omit it and we fetch here.
 */
export async function getPage(url, page) {
  if (page) return page;
  const { res, body, finalUrl } = await fetchPage(url);
  return { body, headers: res.headers, status: res.status, finalUrl: finalUrl ?? res.url };
}

/**
 * Fetch an origin-level resource (robots.txt, llms.txt) once and share it.
 *
 * Several checks need the same file — auditRobots and auditAiCrawlers both read
 * robots.txt — so a full audit would otherwise request it twice. Callers pass a
 * cache Map that lives for the duration of one audit; individual tool calls omit
 * it and each fetch stands alone.
 *
 * Failures are cached too: a site with no robots.txt should be probed once, not
 * once per interested check.
 */
export async function getResource(url, cache) {
  if (!cache) return fetchResource(url);
  if (!cache.has(url)) cache.set(url, fetchResource(url));
  return cache.get(url);
}

async function fetchResource(url) {
  try {
    const { res, body, finalUrl } = await fetchPage(url);
    return { ok: res.ok, status: res.status, body, headers: res.headers, finalUrl: finalUrl ?? res.url, error: null };
  } catch (err) {
    return { ok: false, status: 0, body: "", headers: new Headers(), finalUrl: url, error: err };
  }
}

/** A per-audit cache for origin-level resources. */
export const newResourceCache = () => new Map();

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export const pass = (msg) => `✅ ${msg}`;
export const warn = (msg) => `⚠️ ${msg}`;
export const fail = (msg) => `❌ ${msg}`;

export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Light plural/stem normalization: "brokers" ≈ "broker", "boxes" ≈ "box". */
export function stemWord(w) {
  w = w.toLowerCase();
  if (/(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

export function toStemmedWords(s) {
  return (s || "")
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter(Boolean)
    .map(stemWord);
}

/** Count stem-tolerant occurrences of a keyword phrase in a text. */
export function countPhrase(textStr, kw) {
  const words = toStemmedWords(textStr);
  const kwWords = toStemmedWords(kw);
  if (!kwWords.length) return 0;
  let count = 0;
  for (let i = 0; i <= words.length - kwWords.length; i++) {
    if (kwWords.every((w, j) => words[i + j] === w)) count++;
  }
  return count;
}

export function severityOf(line) {
  if (line.startsWith("❌")) return "fail";
  if (line.startsWith("⚠️")) return "warn";
  if (line.startsWith("✅")) return "pass";
  return "note";
}

/**
 * Normalize a check line into a stable key so the same issue matches across
 * pages/runs despite page-specific numbers/quotes (e.g. "11/77 images" vs "3/9").
 */
export function checkKey(section, line) {
  return `${section}::${line
    .replace(/^([✅⚠️❌]️?\s*)/u, "")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+/g, "#")
    .slice(0, 160)}`;
}

/** Split a section report string into { section, checks: [{severity, line}] }. */
export function parseSection(report) {
  const lines = report.split("\n");
  const section = lines[0].replace(/^#+\s*/, "");
  const checks = [];
  let current = null;
  for (const line of lines.slice(1)) {
    const sev = severityOf(line);
    if (sev !== "note" || !current) {
      current = { severity: sev, line };
      checks.push(current);
    } else {
      current.line += `\n${line}`; // continuation (multi-line fix snippets)
    }
  }
  return { section, checks };
}

/**
 * Fetch a URL following redirects manually so the full chain is recorded
 * (crawl_audit reports multi-hop chains as an SEO issue). Every hop is
 * re-validated, and a repeated URL aborts the walk so a redirect loop can't
 * spin until the hop limit.
 */
export async function fetchWithChain(url, maxHops = config.maxRedirectHops) {
  const chain = [];
  const seen = new Set();
  let current = assertFetchableUrl(url).href;

  for (let i = 0; i <= maxHops; i++) {
    if (seen.has(current)) {
      log.debug("Redirect loop detected", { url: current, hops: chain.length });
      return { chain, finalUrl: current, status: 0, headers: new Headers(), body: "", loop: true };
    }
    seen.add(current);

    await assertResolvesPublic(current);
    const res = await fetch(current, {
      headers: FETCH_HEADERS,
      redirect: "manual",
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });

    if (REDIRECT_STATUSES.includes(res.status)) {
      chain.push({ url: current, status: res.status });
      const loc = res.headers.get("location");
      await res.body?.cancel?.().catch(() => {});
      if (!loc) return { chain, finalUrl: current, status: res.status, headers: res.headers, body: "" };
      current = assertRedirectTarget(loc, current).href;
      continue;
    }
    const body = await readCapped(res);
    return { chain, finalUrl: current, status: res.status, headers: res.headers, body };
  }
  return { chain, finalUrl: current, status: 0, headers: new Headers(), body: "" };
}

/** Non-navigable href schemes that should never be treated as crawlable links. */
const NON_HTTP_HREF = /^(mailto:|tel:|sms:|javascript:|data:|blob:|file:|ftp:|about:)/i;

/**
 * Extract normalized same-origin links from a page body.
 *
 * Hash fragments are stripped rather than excluded, so "/page#section" is
 * correctly collected as "/page" instead of being skipped.
 */
export function extractInternalLinks(body, baseUrl, origin) {
  const links = new Set();
  for (const m of body.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (!href || href.startsWith("#") || NON_HTTP_HREF.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.origin !== origin) continue;
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      u.hash = "";
      links.add(u.href);
    } catch {
      /* unparsable href — skip silently, malformed markup is common */
    }
  }
  return [...links];
}
