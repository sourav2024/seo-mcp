#!/usr/bin/env node
/**
 * seo-mcp — Technical SEO audit MCP server.
 *
 * Implements the "Technical SEO Cheat Sheet" as MCP tools:
 * rendering, HTTPS, clean URLs, page essentials (title/meta/h1/canonical/OG,
 * mobile viewport, images/lazy-loading), caching headers, sitemap.xml,
 * robots.txt, and an optional Lighthouse run (speed / LCP <= 2.5s).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UA =
  "Mozilla/5.0 (compatible; seo-mcp/1.0; +https://github.com/truxo/seo-mcp)";

const server = new McpServer({ name: "technical-seo", version: "1.0.0" });

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function normalizeUrl(url) {
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

async function fetchPage(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    ...opts,
  });
  const body = await res.text();
  return { res, body };
}

const pass = (msg) => `✅ ${msg}`;
const warn = (msg) => `⚠️ ${msg}`;
const fail = (msg) => `❌ ${msg}`;

/* ---------------- 1) Rendering / CMS output ---------------- */
async function auditRendering(url) {
  const lines = ["## Rendering (server-rendered HTML vs client-side JS)"];
  const { body } = await fetchPage(url);
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const inner = (bodyMatch ? bodyMatch[1] : body)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (inner.length < 200) {
    lines.push(
      fail(
        `Page appears to be a client-side JS shell (only ${inner.length} chars of visible text without JS). ` +
          `Google/AI crawlers may struggle to interpret it. Prefer server-rendered HTML (SSR/SSG: Next.js, Astro, prerendering).`
      )
    );
  } else {
    lines.push(
      pass(
        `Server returns rendered HTML (${inner.length} chars of visible text without JS).`
      )
    );
  }
  return lines.join("\n");
}

/* ---------------- 2) HTTPS / SSL ---------------- */
async function auditHttps(url) {
  const lines = ["## HTTPS / SSL"];
  const u = new URL(normalizeUrl(url));
  try {
    const res = await fetch(`https://${u.host}${u.pathname}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    lines.push(pass(`https:// serves with a valid certificate (HTTP ${res.status}).`));
  } catch (e) {
    lines.push(fail(`https:// failed: ${e.cause?.code || e.message}. A valid SSL cert is non-negotiable (Let's Encrypt is free).`));
    return lines.join("\n");
  }
  try {
    const res = await fetch(`http://${u.host}${u.pathname}`, {
      headers: { "User-Agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const loc = res.headers.get("location") || "";
    if ([301, 308].includes(res.status) && loc.startsWith("https://")) {
      lines.push(pass(`http:// 301/308-redirects to https:// (${loc}).`));
    } else if ([302, 307].includes(res.status) && loc.startsWith("https://")) {
      lines.push(warn(`http:// redirects to https:// but with a temporary ${res.status} — use a permanent 301 to preserve link equity.`));
    } else {
      lines.push(fail(`http:// returned ${res.status} without redirecting to https:// — add a 301 redirect.`));
    }
  } catch {
    lines.push(warn(`http:// not reachable (port 80 may be closed) — fine as long as no links point to http://.`));
  }
  return lines.join("\n");
}

/* ---------------- 3) Clean URLs ---------------- */
function auditUrlStructure(urls) {
  const lines = ["## Clean, short URLs"];
  for (const raw of urls) {
    const u = new URL(normalizeUrl(raw));
    const issues = [];
    const full = u.href;
    if (full.length > 60) issues.push(`length ${full.length} chars (aim ≤ ~60)`);
    if (/[A-Z]/.test(u.pathname)) issues.push("contains uppercase letters");
    if (/_/.test(u.pathname)) issues.push("uses underscores (use hyphens instead)");
    if (/[^\x00-\x7F]/.test(full)) issues.push("contains accents/non-ASCII characters");
    if (u.search && /(\bid=|\bp=|\bpage_id=)/i.test(u.search))
      issues.push(`messy parameters (${u.search}) — prefer readable paths`);
    const depth = u.pathname.split("/").filter(Boolean).length;
    if (depth > 4) issues.push(`deep nesting (${depth} levels) — reflect a simple hierarchy`);
    lines.push(
      issues.length
        ? fail(`${raw} → ${issues.join("; ")}`)
        : pass(`${raw} looks clean.`)
    );
  }
  lines.push(
    "Note: if you rename any URL, add a 301 redirect old → new to preserve equity and avoid 404s."
  );
  return lines.join("\n");
}

/* ---------------- 4) Page essentials (metadata, mobile, UX, images) ---------------- */
async function auditPageEssentials(url) {
  const lines = ["## Page essentials (metadata, mobile-first, images)"];
  const { body } = await fetchPage(url);

  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  if (!title) lines.push(fail("Missing <title>."));
  else if (title.length > 65) lines.push(warn(`<title> is ${title.length} chars — keep ~60 or less: "${title.slice(0, 80)}…"`));
  else lines.push(pass(`<title> present (${title.length} chars): "${title}"`));

  const metaDesc = body.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0];
  const descContent = metaDesc?.match(/content=["']([^"']*)["']/i)?.[1];
  if (!descContent) lines.push(fail("Missing meta description."));
  else lines.push(pass(`Meta description present (${descContent.length} chars).`));

  const h1s = body.match(/<h1[\s>]/gi) || [];
  if (h1s.length === 0) lines.push(fail("No <h1> found."));
  else if (h1s.length > 1) lines.push(warn(`${h1s.length} <h1> tags — use exactly one.`));
  else lines.push(pass("Exactly one <h1>."));

  if (/<link[^>]+rel=["']canonical["']/i.test(body)) lines.push(pass("Canonical tag present."));
  else lines.push(warn("No canonical tag — add one to avoid duplicate-content issues."));

  if (/<meta[^>]+property=["']og:title["']/i.test(body)) lines.push(pass("Open Graph tags present."));
  else lines.push(warn("No Open Graph tags — links shared to social will render poorly."));

  // Mobile-first: viewport meta (Google indexes mobile first; ~60% of traffic is mobile)
  if (/<meta[^>]+name=["']viewport["'][^>]*width=device-width/i.test(body))
    lines.push(pass("Responsive viewport meta present (mobile-first ready)."));
  else lines.push(fail("Missing responsive viewport meta — weak mobile UX drags down rankings."));

  // Images: lazy loading + modern formats
  const imgs = body.match(/<img[^>]*>/gi) || [];
  if (imgs.length) {
    const lazy = imgs.filter((i) => /loading=["']lazy["']/i.test(i)).length;
    const modern = imgs.filter((i) => /\.(webp|avif)/i.test(i)).length;
    lines.push(
      lazy / imgs.length >= 0.5
        ? pass(`${lazy}/${imgs.length} images lazy-loaded.`)
        : warn(`Only ${lazy}/${imgs.length} images lazy-loaded — enable lazy loading.`)
    );
    lines.push(
      modern > 0
        ? pass(`${modern}/${imgs.length} images use WebP/AVIF.`)
        : warn(`No WebP/AVIF images detected — compress (TinyPNG/Squoosh) and serve WebP where safe.`)
    );
  } else {
    lines.push(pass("No <img> tags found in initial HTML."));
  }
  return lines.join("\n");
}

/* ---------------- 5) Caching / speed headers ---------------- */
async function auditCaching(url) {
  const lines = ["## Caching & delivery headers"];
  const { res, body } = await fetchPage(url);
  const cc = res.headers.get("cache-control");
  const enc = res.headers.get("content-encoding");
  const etag = res.headers.get("etag") || res.headers.get("last-modified");

  lines.push(cc ? pass(`Cache-Control: ${cc}`) : warn("No Cache-Control header — enable page/browser caching for a dramatic speed boost."));
  lines.push(enc ? pass(`Compression enabled (${enc}).`) : warn("No content-encoding (gzip/br) detected — enable compression."));
  lines.push(etag ? pass("ETag/Last-Modified present (revalidation supported).") : warn("No ETag/Last-Modified — revalidation not possible."));

  const sizeKb = Math.round(Buffer.byteLength(body) / 1024);
  lines.push(
    sizeKb > 300
      ? warn(`HTML document is ${sizeKb} KB — consider minifying HTML/CSS/JS and trimming bloat.`)
      : pass(`HTML document size: ${sizeKb} KB.`)
  );
  return lines.join("\n");
}

/* ---------------- 6) Sitemap ---------------- */
async function auditSitemap(url) {
  const lines = ["## Sitemap"];
  const origin = new URL(normalizeUrl(url)).origin;
  const smUrl = `${origin}/sitemap.xml`;
  try {
    const { res, body } = await fetchPage(smUrl);
    if (!res.ok) {
      lines.push(fail(`${smUrl} returned HTTP ${res.status}. Generate one (Yoast/next-sitemap/framework-native, or xml-sitemaps.com) and keep it auto-updated.`));
      return lines.join("\n");
    }
    const isIndex = /<sitemapindex/i.test(body);
    const locs = body.match(/<loc>/gi)?.length || 0;
    if (locs === 0 && !isIndex) {
      lines.push(warn(`${smUrl} exists but contains 0 <loc> entries — it isn't telling search engines about any pages.`));
    } else {
      lines.push(pass(`${smUrl} exists (${isIndex ? "sitemap index" : "urlset"}, ${locs} <loc> entries).`));
    }
    const badPaths = body.match(/<loc>[^<]*(\/admin\/|\/cart|\/checkout|\?s=|\/search\?)[^<]*<\/loc>/gi);
    if (badPaths?.length)
      lines.push(warn(`${badPaths.length} entries look like admin/cart/checkout/search pages — include only valuable, canonical URLs.`));
    else lines.push(pass("No admin/cart/checkout/search entries detected."));
  } catch (e) {
    lines.push(fail(`Could not fetch ${smUrl}: ${e.message}`));
  }
  return lines.join("\n");
}

/* ---------------- 7) Robots.txt ---------------- */
async function auditRobots(url) {
  const lines = ["## Robots.txt"];
  const origin = new URL(normalizeUrl(url)).origin;
  const rUrl = `${origin}/robots.txt`;
  try {
    const { res, body } = await fetchPage(rUrl);
    if (!res.ok) {
      lines.push(
        fail(`${rUrl} returned HTTP ${res.status}. Add one, e.g.:\n\nUser-agent: *\nDisallow: /admin/\nAllow: /\nSitemap: ${origin}/sitemap.xml`)
      );
      return lines.join("\n");
    }
    lines.push(pass(`${rUrl} exists.`));
    if (/sitemap:/i.test(body)) lines.push(pass("Sitemap referenced in robots.txt."));
    else lines.push(warn(`No Sitemap: line — add "Sitemap: ${origin}/sitemap.xml".`));
    if (/^\s*Disallow:\s*\/\s*$/im.test(body))
      lines.push(fail("Contains 'Disallow: /' — the ENTIRE site is blocked from crawling!"));
    lines.push("Note: robots.txt only blocks crawling — it does NOT de-index already-indexed pages (use noindex for that).");
  } catch (e) {
    lines.push(fail(`Could not fetch ${rUrl}: ${e.message}`));
  }
  return lines.join("\n");
}

/* ---------------- 8) On-page keyword placement ---------------- */
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function auditKeywordPlacement(url, keyword) {
  const kw = keyword.toLowerCase().trim();
  const lines = [`## Keyword placement — "${keyword}" on ${url}`];
  const { body } = await fetchPage(url);
  const has = (s) => (s || "").toLowerCase().includes(kw);

  // Title
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
  lines.push(
    has(title)
      ? pass(`Keyword in <title>: "${title}"`) +
        (title.toLowerCase().indexOf(kw) > 30 ? `\n${warn("Keyword appears late in the title — front-load it when natural.")}` : "")
      : fail(`Keyword not in <title> ("${title}"). The title is the strongest on-page placement.`)
  );

  // URL
  const slugKw = kw.replace(/\s+/g, "-");
  const path = new URL(normalizeUrl(url)).pathname.toLowerCase();
  lines.push(
    path.includes(slugKw) || has(decodeURIComponent(path).replace(/[-_/]/g, " "))
      ? pass("Keyword present in the URL path.")
      : warn(`Keyword not in URL path (${path}) — include one primary keyword if it fits, no stuffing.`)
  );

  // Meta description
  const desc = body.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
    || body.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] || "";
  lines.push(
    has(desc)
      ? pass("Keyword in meta description.")
      : warn(`Keyword not in meta description — it doesn't affect ranking directly but boosts click-through when bolded in results.`)
  );

  // H1 and H2s
  const h1 = stripTags(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  lines.push(
    has(h1)
      ? pass(`Keyword in <h1>: "${h1}"`)
      : fail(`Keyword not in <h1> ("${h1 || "none found"}").`)
  );
  const h2s = [...body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripTags(m[1]));
  const h2Hits = h2s.filter((h) => has(h)).length;
  lines.push(
    h2s.length === 0
      ? warn("No <h2> subheadings found — structure content with keyword-bearing subheadings.")
      : h2Hits > 0
        ? pass(`Keyword (or variant) in ${h2Hits}/${h2s.length} <h2> subheadings.`)
        : warn(`Keyword in 0/${h2s.length} <h2> subheadings — work it (or close variants) into at least one.`)
  );

  // First paragraph / first 100 words
  const visible = stripTags(body.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || body);
  const first100 = visible.split(/\s+/).slice(0, 100).join(" ");
  lines.push(
    has(first100)
      ? pass("Keyword appears in the first ~100 words of visible content.")
      : warn("Keyword not in the first ~100 words — introduce it early in the opening paragraph.")
  );

  // Image alt text
  const imgs = body.match(/<img[^>]*>/gi) || [];
  const alts = imgs.map((i) => i.match(/alt=["']([^"']*)["']/i)?.[1] || "");
  const missingAlt = alts.filter((a) => !a.trim()).length;
  const altHits = alts.filter((a) => has(a)).length;
  if (imgs.length) {
    lines.push(
      altHits > 0
        ? pass(`Keyword in ${altHits}/${imgs.length} image alt attributes.`)
        : warn(`Keyword in 0/${imgs.length} image alt attributes — describe at least one relevant image with it.`)
    );
    if (missingAlt > 0) lines.push(warn(`${missingAlt}/${imgs.length} images have no alt text at all (accessibility + image SEO).`));
  }

  // Density
  const words = visible.toLowerCase().split(/\s+/).filter(Boolean);
  const kwWords = kw.split(/\s+/);
  let count = 0;
  for (let i = 0; i <= words.length - kwWords.length; i++) {
    if (kwWords.every((w, j) => words[i + j]?.replace(/[^\p{L}\p{N}-]/gu, "") === w)) count++;
  }
  const density = words.length ? ((count * kwWords.length) / words.length) * 100 : 0;
  lines.push(
    count === 0
      ? fail("Keyword does not appear in the body content at all.")
      : density > 3
        ? fail(`Keyword density ${density.toFixed(1)}% (${count}×) — reads as stuffing; aim for ~0.5–2% used naturally.`)
        : density < 0.3
          ? warn(`Keyword density ${density.toFixed(2)}% (${count}× in ${words.length} words) — thin; use it and close variants a bit more.`)
          : pass(`Keyword density ${density.toFixed(1)}% (${count}× in ${words.length} words) — in the healthy ~0.5–2% range.`)
  );

  lines.push(
    "Reminder: place keywords where they read naturally — title, URL, H1, early paragraph, one subheading, one alt text. Never stuff."
  );
  return lines.join("\n");
}

/* ---------------- 9) Lighthouse (speed / LCP) ---------------- */
async function runLighthouse(url, formFactor) {
  const args = [
    "-y",
    "lighthouse",
    normalizeUrl(url),
    "--only-categories=performance,seo",
    '--chrome-flags=--headless=new',
    "--output=json",
    "--quiet",
  ];
  if (formFactor === "desktop") args.push("--preset=desktop");
  const { stdout } = await execFileAsync("npx", args, {
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const r = JSON.parse(stdout);
  const perf = Math.round((r.categories.performance?.score ?? 0) * 100);
  const seo = Math.round((r.categories.seo?.score ?? 0) * 100);
  const lcp = r.audits["largest-contentful-paint"]?.numericValue;
  const lcpS = lcp != null ? (lcp / 1000).toFixed(2) : "?";
  const lines = [
    `## Lighthouse (${formFactor})`,
    `Performance: ${perf}/100 · SEO: ${seo}/100`,
    lcp != null && lcp <= 2500
      ? pass(`LCP ${lcpS}s (target ≤ 2.5s).`)
      : fail(`LCP ${lcpS}s — target is ≤ 2.5s. Over ~3s you start losing visitors.`),
    "Usual bottlenecks: slow hosting, heavy images, render-blocking CSS/JS, bloated themes/plugins.",
  ];
  const opportunities = Object.values(r.audits)
    .filter((a) => a.details?.type === "opportunity" && a.numericValue > 100)
    .sort((a, b) => b.numericValue - a.numericValue)
    .slice(0, 5)
    .map((a) => `- ${a.title} (~${Math.round(a.numericValue)}ms savings)`);
  if (opportunities.length) lines.push("Top opportunities:", ...opportunities);
  return lines.join("\n");
}

/* ================= Tool registrations ================= */

server.registerTool(
  "seo_full_audit",
  {
    title: "Full technical SEO audit",
    description:
      "Run the full technical SEO checklist on a URL: rendering (server-rendered vs JS shell), HTTPS/SSL + redirect, page essentials (title, meta description, h1, canonical, Open Graph, mobile viewport, image lazy-loading/WebP), caching headers, sitemap.xml, and robots.txt. Returns a Markdown report with ✅/⚠️/❌ per check. Does not include Lighthouse (use run_lighthouse separately — it is slower).",
    inputSchema: { url: z.string().describe("Page URL to audit, e.g. https://example.com") },
  },
  async ({ url }) => {
    url = normalizeUrl(url);
    const sections = await Promise.allSettled([
      auditRendering(url),
      auditHttps(url),
      auditPageEssentials(url),
      auditCaching(url),
      auditSitemap(url),
      auditRobots(url),
    ]);
    const report = sections
      .map((s) => (s.status === "fulfilled" ? s.value : fail(`Check failed: ${s.reason?.message}`)))
      .join("\n\n");
    return text(`# Technical SEO audit — ${url}\n\n${report}\n\n${auditUrlStructure([url])}`);
  }
);

server.registerTool(
  "check_rendering",
  {
    title: "Check server-rendered HTML",
    description:
      "Fetch a page without executing JavaScript and detect whether it serves real server-rendered HTML or an empty client-side JS shell (hard for Google/AI to interpret).",
    inputSchema: { url: z.string() },
  },
  async ({ url }) => text(await auditRendering(normalizeUrl(url)))
);

server.registerTool(
  "check_https",
  {
    title: "Check HTTPS / SSL",
    description:
      "Verify the site serves https:// with a valid certificate and that http:// permanently (301) redirects to https://.",
    inputSchema: { url: z.string() },
  },
  async ({ url }) => text(await auditHttps(url))
);

server.registerTool(
  "check_url_structure",
  {
    title: "Check clean-URL rules",
    description:
      "Analyze one or more URLs against clean-URL best practices: ≤ ~60 chars, lowercase, hyphens not underscores, no accents/special chars, no messy query params, shallow hierarchy.",
    inputSchema: { urls: z.array(z.string()).describe("URLs to analyze") },
  },
  async ({ urls }) => text(auditUrlStructure(urls))
);

server.registerTool(
  "check_page_essentials",
  {
    title: "Check on-page essentials",
    description:
      "Check a page's title, meta description, single h1, canonical tag, Open Graph tags, responsive viewport meta (mobile-first), image lazy-loading, and WebP/AVIF usage.",
    inputSchema: { url: z.string() },
  },
  async ({ url }) => text(await auditPageEssentials(normalizeUrl(url)))
);

server.registerTool(
  "check_caching",
  {
    title: "Check caching & delivery headers",
    description:
      "Inspect Cache-Control, content-encoding (gzip/brotli), ETag/Last-Modified headers and HTML document size for easy speed wins.",
    inputSchema: { url: z.string() },
  },
  async ({ url }) => text(await auditCaching(normalizeUrl(url)))
);

server.registerTool(
  "check_sitemap",
  {
    title: "Check sitemap.xml",
    description:
      "Fetch /sitemap.xml, count entries, and flag admin/cart/checkout/internal-search URLs that should be excluded.",
    inputSchema: { url: z.string().describe("Any URL on the site — the origin's /sitemap.xml is checked") },
  },
  async ({ url }) => text(await auditSitemap(url))
);

server.registerTool(
  "check_robots",
  {
    title: "Check robots.txt",
    description:
      "Fetch /robots.txt, verify it exists, references the sitemap, and does not block the entire site.",
    inputSchema: { url: z.string().describe("Any URL on the site — the origin's /robots.txt is checked") },
  },
  async ({ url }) => text(await auditRobots(url))
);

server.registerTool(
  "check_keyword_placement",
  {
    title: "Check on-page keyword placement",
    description:
      "Analyze where a target keyword appears on a page: <title> (and whether it's front-loaded), URL path, meta description, H1, H2 subheadings, first ~100 words, image alt text, and keyword density (flags both thin usage and stuffing). Returns ✅/⚠️/❌ per placement.",
    inputSchema: {
      url: z.string().describe("Page URL to analyze"),
      keyword: z.string().describe("Target keyword or phrase, e.g. 'freight broker software'"),
    },
  },
  async ({ url, keyword }) =>
    text(await auditKeywordPlacement(normalizeUrl(url), keyword))
);

server.registerTool(
  "run_lighthouse",
  {
    title: "Run Lighthouse (speed & LCP)",
    description:
      "Run Google Lighthouse (performance + SEO categories) on a URL via npx. Reports scores, LCP against the ≤ 2.5s target, and top speed opportunities. Slow (~1-2 min); requires Chrome installed.",
    inputSchema: {
      url: z.string(),
      form_factor: z.enum(["mobile", "desktop"]).default("mobile").describe("mobile (default, matches Google's mobile-first indexing) or desktop"),
    },
  },
  async ({ url, form_factor }) => {
    try {
      return text(await runLighthouse(url, form_factor));
    } catch (e) {
      return text(fail(`Lighthouse failed: ${e.message}. Ensure Chrome is installed; try 'npx lighthouse ${url}' manually.`));
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("technical-seo MCP server running on stdio");
