import {
  normalizeUrl,
  fetchWithChain,
  extractInternalLinks,
  parseSection,
  checkKey,
  delay,
  pass,
  warn,
  fail,
} from "./helpers.js";
import { auditRendering } from "./rendering.js";
import { auditPageEssentials } from "./page-essentials.js";
import { auditCaching } from "./caching.js";
import { collectSitemapUrls } from "./sitemap.js";
import { config } from "../src/config.js";
import { log } from "../src/logger.js";

/* ---------------- Site crawl audit ---------------- */
/** Cap on extra (non-audited) internal links probed for 404s per crawl. */
const LINK_CHECK_CAP = 20;

/**
 * Canonical form for status/visited bookkeeping.
 *
 * `extractInternalLinks` returns URLs normalized by the URL parser, so a start
 * URL of "http://host" becomes the link "http://host/". Keying on the raw string
 * meant the crawler failed to recognize its own pages and re-fetched them during
 * the broken-link pass. Normalizing both sides keeps one URL to one request.
 */
function urlKey(u) {
  try {
    const parsed = new URL(u);
    parsed.hash = "";
    if (parsed.pathname === "") parsed.pathname = "/";
    return parsed.href;
  } catch {
    return u;
  }
}

/**
 * @param {string}   url        site URL to crawl
 * @param {number}   maxPages   page cap
 * @param {object}   [opts]
 * @param {Function} [opts.onProgress] called as (pagesDone, message) for client progress
 * @param {AbortSignal} [opts.signal]  aborts the crawl between pages when the client cancels
 */
export async function crawlAudit(url, maxPages, { onProgress, signal } = {}) {
  url = normalizeUrl(url);
  const notes = [];
  const report = onProgress ?? (async () => {});
  const abortIfCancelled = () => {
    if (signal?.aborted) throw new Error("The request was cancelled by the client.");
  };

  // Check before the first request, not just between pages: a client that
  // cancels immediately should cause no network traffic at all.
  abortIfCancelled();

  // 0. Resolve the start URL first — if the site lives on a different host
  //    (e.g. a root domain that 301s to an app subdomain), crawl there.
  const start = await fetchWithChain(url);
  const origin = new URL(start.finalUrl).origin;
  if (origin !== new URL(url).origin) {
    notes.push(warn(`${url} redirects to ${start.finalUrl} — crawling ${origin} instead.`));
    url = start.finalUrl;
  }
  const prefetched = new Map([[urlKey(url), start]]);

  // 1. Seed from sitemap.xml (index-aware); fall back to BFS from the start URL.
  const sitemapUrls = await collectSitemapUrls(origin);
  const bfsMode = sitemapUrls.length === 0;
  const queue = bfsMode ? [url] : [url, ...sitemapUrls];
  notes.push(
    bfsMode
      ? warn("sitemap.xml missing or empty — crawling by following internal links from the start URL instead.")
      : `Seeded from sitemap.xml: ${sitemapUrls.length} URLs${sitemapUrls.length + 1 > maxPages ? ` (auditing first ${maxPages})` : ""}.`
  );

  // 2. Crawl politely, fetching each page exactly once.
  //
  //    Workers pull from the shared queue rather than being handed a fixed slice,
  //    so BFS still works: links discovered by one worker are picked up by any
  //    idle worker. `visited` is claimed before the await, which is what keeps
  //    two workers from racing onto the same URL.
  const pages = []; // { url, status, chain, title, desc, links, sections }
  const statusByUrl = new Map();
  const visited = new Set();
  let inFlight = 0;

  async function auditOne(target) {
    let fetched = prefetched.get(urlKey(target));
    try {
      if (!fetched) {
        // Delay per fetch, not per worker, so raising concurrency raises the
        // request rate rather than silently removing the politeness gap.
        if (pages.length > 0 || inFlight > 1) await delay(config.crawlDelayMs);
        fetched = await fetchWithChain(target);
      }
    } catch (e) {
      pages.push({ url: target, status: 0, chain: [], error: e.message, links: [], sections: [] });
      statusByUrl.set(urlKey(target), 0);
      return;
    }
    const { chain, finalUrl, status, headers, body } = fetched;
    statusByUrl.set(urlKey(target), status);
    statusByUrl.set(urlKey(finalUrl), status);
    const isHtml = (headers.get("content-type") || "").includes("html");
    const record = { url: target, finalUrl, status, chain, links: [], sections: [] };
    if (status === 200 && isHtml) {
      const page = { body, headers, status, finalUrl };
      record.title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
      record.desc = body.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || "";
      record.links = extractInternalLinks(body, finalUrl, origin);
      const sections = await Promise.all([
        auditRendering(target, page),
        auditPageEssentials(target, page),
        auditCaching(target, page),
      ]);
      record.sections = sections.map(parseSection);
      if (bfsMode) {
        for (const link of record.links) if (!visited.has(urlKey(link))) queue.push(link);
      }
    }
    pages.push(record);
  }

  async function worker() {
    for (;;) {
      // Cancellation and the page cap are both checked per iteration: another
      // worker may have filled the cap, or the client may have gone away.
      abortIfCancelled();
      if (pages.length + inFlight >= maxPages) return;
      const target = queue.shift();
      if (target === undefined) return;
      if (visited.has(urlKey(target))) continue;
      visited.add(urlKey(target));
      inFlight++;
      try {
        await auditOne(target);
        await report(pages.length, `Audited ${pages.length}/${maxPages}: ${target}`);
      } finally {
        inFlight--;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(config.crawlConcurrency, maxPages));
  log.debug("Crawling", { origin, maxPages, concurrency: workerCount, seeded: queue.length, bfsMode });
  // A worker that exits early (empty queue) while another is still discovering
  // links would end the crawl prematurely, so re-run until nothing is left.
  do {
    await Promise.all(Array.from({ length: workerCount }, worker));
  } while (queue.length && pages.length < maxPages);

  const htmlPages = pages.filter((p) => p.sections.length);

  // 3. Broken internal links + redirect chains (statuses reused from the crawl;
  //    a capped number of extra targets checked politely).
  const linkTargets = new Map(); // href -> Set of pages linking to it
  for (const p of htmlPages)
    for (const l of p.links) {
      if (!linkTargets.has(l)) linkTargets.set(l, new Set());
      linkTargets.get(l).add(p.url);
    }
  const chains = pages.filter((p) => p.chain?.length >= 2);
  const broken = [];
  let extraChecked = 0;
  for (const [link, sources] of linkTargets) {
    let status = statusByUrl.get(urlKey(link));
    if (status === undefined) {
      if (extraChecked >= LINK_CHECK_CAP) continue;
      abortIfCancelled();
      extraChecked++;
      await delay(config.crawlDelayMs);
      try {
        const r = await fetchWithChain(link, 3);
        status = r.status;
        statusByUrl.set(urlKey(link), status);
        if (r.chain.length >= 2) chains.push({ url: link, chain: r.chain, status: r.status, finalUrl: r.finalUrl });
      } catch {
        status = 0;
      }
    }
    if (status === 404 || status === 410) broken.push({ link, status, from: [...sources].slice(0, 3) });
  }

  // 4. Duplicate titles / meta descriptions.
  const dupes = [];
  for (const field of ["title", "desc"]) {
    const groups = new Map();
    for (const p of htmlPages) {
      const v = (p[field] || "").trim();
      if (!v) continue;
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(p.url);
    }
    for (const [v, urls] of groups)
      if (urls.length > 1) dupes.push({ field: field === "title" ? "<title>" : "meta description", value: v, urls });
  }

  // 5. Orphan sitemap URLs (never linked from any crawled page).
  //    Compared on canonical keys so "/page" vs "/page/" isn't a false orphan.
  const allLinked = new Set(htmlPages.flatMap((p) => p.links).map(urlKey));
  const startKey = urlKey(url);
  const orphans = bfsMode ? [] : sitemapUrls.filter((u) => !allLinked.has(urlKey(u)) && urlKey(u) !== startKey);

  // 6. Aggregate: site-wide issues (same ⚠️/❌ on >50% of pages) vs per-page.
  const issueCount = new Map(); // key -> { count, sample, severity, section }
  for (const p of htmlPages)
    for (const s of p.sections)
      for (const c of s.checks) {
        if (c.severity !== "warn" && c.severity !== "fail") continue;
        const key = checkKey(s.section, c.line);
        if (!issueCount.has(key))
          issueCount.set(key, { count: 0, sample: c.line, severity: c.severity, section: s.section });
        issueCount.get(key).count++;
      }
  const siteWideKeys = new Set(
    [...issueCount.entries()].filter(([, v]) => v.count > htmlPages.length / 2).map(([k]) => k)
  );

  // 7. Assemble the report.
  const out = [
    `# Crawl audit — ${origin} (${htmlPages.length} pages audited, ${pages.length} URLs fetched)`,
    "",
    ...notes,
  ];

  out.push("", "## Site-wide issues (fix once in the template)");
  const siteWide = [...issueCount.entries()].filter(([k]) => siteWideKeys.has(k));
  if (siteWide.length === 0) out.push(pass("No issue repeats on more than half the pages."));
  for (const [, v] of siteWide.sort((a, b) => (a[1].severity === "fail" ? -1 : 1)))
    out.push(
      `${v.severity === "fail" ? "❌" : "⚠️"} [${v.section}] ${v.sample.replace(/^[✅⚠️❌]️?\s*/u, "")} — on ${v.count}/${htmlPages.length} pages`
    );

  out.push("", "## Broken internal links");
  if (!broken.length)
    out.push(
      pass(
        `No internal 404s found (${linkTargets.size} unique internal links seen, ${extraChecked} extra targets checked).`
      )
    );
  for (const b of broken)
    out.push(
      fail(`${b.link} returns ${b.status} — linked from ${b.from.join(", ")}. Fix the link or 301-redirect the target.`)
    );

  out.push("", "## Redirect chains");
  if (!chains.length) out.push(pass("No multi-hop redirect chains found."));
  for (const c of chains.slice(0, 10))
    out.push(
      warn(
        `${[...c.chain.map((h) => `${h.url} → ${h.status}`), `${c.finalUrl} (${c.status})`].join(" → ")} — link directly to the final URL.`
      )
    );

  out.push("", "## Duplicate titles & meta descriptions");
  if (!dupes.length) out.push(pass("No duplicate titles or meta descriptions across crawled pages."));
  for (const d of dupes.slice(0, 10))
    out.push(
      warn(
        `Duplicate ${d.field} "${d.value.slice(0, 60)}" on ${d.urls.length} pages: ${d.urls.slice(0, 3).join(", ")}${d.urls.length > 3 ? ", …" : ""}`
      )
    );

  if (!bfsMode) {
    out.push("", "## Orphan sitemap URLs (in sitemap, not linked from any crawled page)");
    if (!orphans.length) out.push(pass("No orphans among crawled pages."));
    for (const o of orphans.slice(0, 10))
      out.push(warn(`${o} — add an internal link so crawlers and users can reach it.`));
    if (orphans.length > 10) out.push(`…and ${orphans.length - 10} more.`);
  }

  out.push("", "## Per-page issues (excluding site-wide)");
  let anyPerPage = false;
  for (const p of htmlPages) {
    const own = p.sections.flatMap((s) =>
      s.checks
        .filter(
          (c) => (c.severity === "warn" || c.severity === "fail") && !siteWideKeys.has(checkKey(s.section, c.line))
        )
        .map((c) => `  ${c.line.split("\n")[0]}`)
    );
    const fetchIssues = [];
    if (p.chain.length === 1 && p.chain[0].url.startsWith(origin))
      fetchIssues.push(
        `  ⚠️ URL redirects (${p.chain[0].status}) to ${p.finalUrl} — sitemap/links should use final URLs.`
      );
    if (p.status !== 200) fetchIssues.push(`  ❌ Returned HTTP ${p.status}${p.error ? ` (${p.error})` : ""}.`);
    if (own.length || fetchIssues.length) {
      anyPerPage = true;
      out.push(`### ${p.url}`, ...fetchIssues, ...own);
    }
  }
  if (!anyPerPage) out.push(pass("No page-specific issues beyond the site-wide ones."));

  return out.join("\n");
}
