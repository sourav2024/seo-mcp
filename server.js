#!/usr/bin/env node
/**
 * seo-mcp — Technical & on-page SEO audit MCP server.
 *
 * All checks live in checks/*.js (one audit* function per checklist section);
 * this file only registers them as MCP tools over stdio. Shared infrastructure
 * (config, logging, URL validation, error mapping) lives in src/.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getPage,
  newResourceCache,
  fail,
  auditRendering,
  auditHttps,
  auditUrlStructure,
  auditPageEssentials,
  auditCaching,
  auditSitemap,
  auditRobots,
  auditHreflang,
  auditKeywordPlacement,
  auditStructuredData,
  auditAiCrawlers,
  runLighthouse,
  crawlAudit,
  finishReport,
} from "./checks/index.js";
import { config, initConfig } from "./src/config.js";
import { log } from "./src/logger.js";
import { VERSION, SERVER_NAME } from "./src/version.js";
import { ok, guard, describeError, progressReporter, throwIfCancelled } from "./src/tool-result.js";
import { assertFetchableUrl } from "./src/url-guard.js";

/* ------------------------------------------------------------------ *
 * CLI: --help / --version short-circuit before any server setup.
 * ------------------------------------------------------------------ */
const TOOL_SUMMARY = [
  ["seo_full_audit", "Full checklist on one URL"],
  ["crawl_audit", "Crawl a site and aggregate site-wide issues"],
  ["check_rendering", "Server-rendered HTML vs client-side JS shell"],
  ["check_https", "SSL certificate + http→https redirect"],
  ["check_url_structure", "Clean-URL rules (offline)"],
  ["check_page_essentials", "Title/meta/h1/canonical/OG/viewport/images"],
  ["check_caching", "Cache-Control, compression, ETag, size"],
  ["check_sitemap", "sitemap.xml validity and sampled URLs"],
  ["check_robots", "robots.txt validity"],
  ["check_hreflang", "International SEO: hreflang validity + return links"],
  ["check_keyword_placement", "On-page keyword placement and density"],
  ["check_structured_data", "JSON-LD / schema.org validation"],
  ["check_ai_crawlers", "GPTBot/ClaudeBot/etc. access + noindex"],
  ["run_lighthouse", "Core Web Vitals (requires Chrome)"],
];

function helpText() {
  const tools = TOOL_SUMMARY.map(([n, d]) => `  ${n.padEnd(27)} ${d}`).join("\n");
  return `seo-mcp v${VERSION} — technical & on-page SEO audit MCP server

USAGE
  seo-mcp                 Start the server on stdio (how MCP clients launch it)
  seo-mcp --help, -h      Show this help
  seo-mcp --version, -v   Print the version

This is an MCP server, not an interactive CLI: it speaks JSON-RPC over stdin/stdout
and is meant to be launched by an MCP client. Register it with:

  claude mcp add technical-seo -- npx -y technical-seo-mcp

TOOLS (${TOOL_SUMMARY.length})
${tools}

KEY ENVIRONMENT VARIABLES
  SEO_MCP_LOG_LEVEL           silent|error|warn|info|debug   (default: info)
  SEO_MCP_LOG_FORMAT          json|text                      (default: json)
  SEO_MCP_STATE_DIR           Where baselines are stored
  SEO_MCP_FETCH_TIMEOUT_MS    Per-request timeout            (default: 20000)
  SEO_MCP_CRAWL_DELAY_MS      Politeness delay between pages (default: 500)
  SEO_MCP_CRAWL_CONCURRENCY   Parallel page fetches          (default: 1)
  SEO_MCP_ALLOW_PRIVATE_HOSTS Allow localhost/private IPs    (default: true)
  CHROME_PATH                 Chrome binary for Lighthouse

See .env.example for the full list.
Full documentation: https://github.com/sourav2024/seo-mcp
`;
}

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(helpText());
  process.exit(0);
}
// An unrecognized flag must not silently start the server: a typo would look
// like a hang, and a guess like --transport=http would appear to be accepted.
if (argv.length > 0) {
  process.stderr.write(
    `seo-mcp: unrecognized argument${argv.length > 1 ? "s" : ""}: ${argv.join(" ")}\n` +
      `This server takes no options other than --help and --version; it is configured\n` +
      `through environment variables. Run "seo-mcp --help" for details.\n`
  );
  process.exit(2);
}

initConfig(log);

const server = new McpServer({ name: SERVER_NAME, version: VERSION });

/* ------------------------------------------------------------------ *
 * Shared input schemas
 * ------------------------------------------------------------------ */

/** A URL string, validated for scheme/shape before any network call. */
const urlSchema = (description) =>
  z.string().trim().min(1, "URL must not be empty").max(2048, "URL is too long").describe(description);

const OUTPUT_PARAMS = {
  output: z
    .enum(["markdown", "json", "html"])
    .default("markdown")
    .describe(
      "Report format. markdown (default) returns the report inline; json returns per-check severity and {pass, warn, fail} counts; html writes a standalone, shareable HTML file to disk and returns its path plus a short summary (use when the user wants a report to open, save, or send)"
    ),
  output_path: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "html only — destination file or directory. Defaults to ./seo-report-<host>-<date>.html in the current directory"
    ),
  compare_to_baseline: z
    .boolean()
    .default(false)
    .describe(
      "Diff against (and update) the saved baseline for this target — reports new failures/warnings and items fixed since the last run"
    ),
};

/**
 * NOTE ON outputSchema: the MCP SDK enforces a declared outputSchema on *every*
 * result, but `output` is chosen per call — markdown returns prose and html
 * returns a file path, neither of which is structured data. Declaring a schema
 * makes those modes fail with "no structured content was provided", so none is
 * declared here. `output: "json"` still returns `structuredContent` (built in
 * finishReport) for clients that can consume it. Revisit if the SDK ever
 * supports a schema conditional on input.
 */

/* ------------------------------------------------------------------ *
 * Registration helpers
 * ------------------------------------------------------------------ */

/** Register a tool whose handler is wrapped so exceptions become isError results. */
function registerTool(name, meta, handler) {
  server.registerTool(name, meta, guard(name, handler));
}

/**
 * Register a single-URL check. All ten of these share the same shape — take a
 * URL, run one audit function, return its Markdown — so the wrapper removes the
 * repetition without hiding the per-tool descriptions the model relies on.
 */
function registerUrlCheck(name, { title, description, urlDescription, audit }) {
  registerTool(
    name,
    {
      title,
      description,
      inputSchema: { url: urlSchema(urlDescription ?? "Page URL to check, e.g. https://example.com") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => ok(await audit(assertFetchableUrl(url).href))
  );
}

/* ------------------------------------------------------------------ *
 * Site-level audits
 * ------------------------------------------------------------------ */

registerTool(
  "seo_full_audit",
  {
    title: "Full technical SEO audit",
    description:
      "Run the full technical SEO checklist on a URL: rendering (server-rendered vs JS shell), HTTPS/SSL + redirect, page essentials (title, meta description, h1, canonical, Open Graph, mobile viewport, image lazy-loading/WebP/dimensions), caching headers, structured data (JSON-LD), sitemap.xml, robots.txt, and AI-crawler access. Returns a Markdown report with ✅/⚠️/❌ per check (or structured JSON with output: 'json', or a shareable HTML file with output: 'html'). Set compare_to_baseline: true to diff against the previous run. Does not include Lighthouse (use run_lighthouse separately — it is slower).",
    inputSchema: {
      url: urlSchema("Page URL to audit, e.g. https://example.com"),
      ...OUTPUT_PARAMS,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, output, output_path, compare_to_baseline }, extra) => {
    const target = assertFetchableUrl(url).href;
    log.info("Starting full audit", { url: target, output });
    const reportProgress = progressReporter(extra, 10);

    await reportProgress(1, `Fetching ${target}`);
    // Fetch the page and each origin-level file once, then share them across
    // every check: robots.txt alone is needed by two checks, and the page by five.
    const page = await getPage(target);
    const resources = newResourceCache();
    throwIfCancelled(extra);

    // allSettled: one failing check (e.g. an unreachable sitemap) must not sink
    // the whole audit — each failure is reported in place as a ❌ line.
    const CHECKS = [
      ["Rendering", () => auditRendering(target, page)],
      ["HTTPS", () => auditHttps(target, page)],
      ["Page essentials", () => auditPageEssentials(target, page)],
      ["Caching", () => auditCaching(target, page)],
      ["Structured data", () => auditStructuredData(target, page)],
      ["Sitemap", () => auditSitemap(target, resources)],
      ["Robots", () => auditRobots(target, resources)],
      // Return-link verification stays off here: the full audit is a single-page
      // report and reciprocity costs one request per alternate. check_hreflang
      // with verify_return_links: true is the deliberate deep pass.
      ["Hreflang", () => auditHreflang(target, page)],
      ["AI crawlers", () => auditAiCrawlers(target, page, resources)],
    ];
    let completed = 1;
    const settled = await Promise.allSettled(
      CHECKS.map(([label, run]) =>
        run().finally(() => reportProgress(++completed, `Completed ${completed - 1}/${CHECKS.length}: ${label}`))
      )
    );
    const report = settled
      .map((s, i) => {
        if (s.status === "fulfilled") return s.value;
        const [label] = CHECKS[i];
        log.warn("Check failed within full audit", { check: label, url: target, err: s.reason });
        return `## ${label}\n${fail(`Check failed: ${describeError(s.reason, { url: target })}`)}`;
      })
      .join("\n\n");

    const markdown = `# Technical SEO audit — ${target}\n\n${report}\n\n${auditUrlStructure([target])}`;
    await reportProgress(10, "Building report");
    return finishReport(target, markdown, { output, output_path, compare_to_baseline });
  }
);

registerTool(
  "crawl_audit",
  {
    title: "Crawl and audit multiple pages",
    description:
      "Crawl a site (seeded from sitemap.xml, sitemap-index aware; falls back to following internal links) and audit up to max_pages pages with a polite delay. Each page is fetched once and shared across checks. Aggregates: site-wide issues (same problem on >50% of pages — fix once in the template), broken internal links (404s), multi-hop redirect chains, duplicate titles/meta descriptions, orphan sitemap URLs, and remaining per-page issues.",
    inputSchema: {
      url: urlSchema("Site URL to crawl, e.g. https://example.com"),
      max_pages: z
        .number()
        .int()
        .min(1)
        .max(config.crawlMaxPagesLimit)
        .default(25)
        .describe(`Maximum pages to audit (default 25, max ${config.crawlMaxPagesLimit})`),
      ...OUTPUT_PARAMS,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, max_pages, output, output_path, compare_to_baseline }, extra) => {
    const target = assertFetchableUrl(url).href;
    log.info("Starting crawl", { url: target, maxPages: max_pages });
    const reportProgress = progressReporter(extra, max_pages);
    const markdown = await crawlAudit(target, max_pages, {
      onProgress: reportProgress,
      signal: extra?.signal,
    });
    return finishReport(`crawl:${target}`, markdown, { output, output_path, compare_to_baseline });
  }
);

/* ------------------------------------------------------------------ *
 * Single-URL technical checks
 * ------------------------------------------------------------------ */

registerUrlCheck("check_rendering", {
  title: "Check server-rendered HTML",
  description:
    "Fetch a page without executing JavaScript and detect whether it serves real server-rendered HTML or an empty client-side JS shell (hard for Google/AI to interpret).",
  audit: (url) => auditRendering(url),
});

registerUrlCheck("check_https", {
  title: "Check HTTPS / SSL",
  description:
    "Verify the site serves https:// with a valid certificate and that http:// permanently (301) redirects to https://.",
  audit: (url) => auditHttps(url),
});

registerUrlCheck("check_page_essentials", {
  title: "Check on-page essentials",
  description:
    "Check a page's title, meta description, single h1, canonical tag, Open Graph tags, responsive viewport meta (mobile-first), image lazy-loading, WebP/AVIF usage, and explicit image width/height (CLS risk).",
  audit: (url) => auditPageEssentials(url),
});

registerUrlCheck("check_caching", {
  title: "Check caching & delivery headers",
  description:
    "Inspect Cache-Control, content-encoding (gzip/brotli), ETag/Last-Modified headers and HTML document size for easy speed wins.",
  audit: (url) => auditCaching(url),
});

registerUrlCheck("check_sitemap", {
  title: "Check sitemap.xml",
  description:
    "Fetch /sitemap.xml, count entries, flag admin/cart/checkout/internal-search URLs, sample up to 10 <loc> URLs to verify they return 200 without redirects, and check lastmod presence/freshness.",
  urlDescription: "Any URL on the site — the origin's /sitemap.xml is checked",
  audit: (url) => auditSitemap(url),
});

registerUrlCheck("check_robots", {
  title: "Check robots.txt",
  description:
    "Fetch /robots.txt, verify it exists and is valid (not an HTML page or redirect), references the sitemap, and does not block the entire site.",
  urlDescription: "Any URL on the site — the origin's /robots.txt is checked",
  audit: (url) => auditRobots(url),
});

registerTool(
  "check_hreflang",
  {
    title: "Check hreflang / international SEO",
    description:
      "Audit a page's hreflang annotations for multi-language or multi-country targeting (e.g. US + Canada): validates BCP-47 values (catching en_US, en-UK and other common mistakes), requires a self-referencing annotation, checks for x-default, flags duplicate/conflicting values and relative hrefs, and verifies <html lang> agrees. With verify_return_links: true it fetches each alternate and confirms it links back — missing return links are the most common reason Google ignores an otherwise-correct hreflang cluster. A single-language site correctly reports that hreflang is not needed.",
    inputSchema: {
      url: urlSchema("Page URL to audit, e.g. https://example.com/"),
      verify_return_links: z
        .boolean()
        .default(false)
        .describe(
          "Fetch each alternate URL and confirm it points back to this page (reciprocity). Adds one request per alternate — off by default"
        ),
      max_alternates: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum alternates to fetch when verify_return_links is true (default 10)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, verify_return_links, max_alternates }) =>
    ok(
      await auditHreflang(assertFetchableUrl(url).href, undefined, {
        verifyReturnLinks: verify_return_links,
        maxAlternates: max_alternates,
      })
    )
);

registerUrlCheck("check_structured_data", {
  title: "Check structured data (JSON-LD)",
  description:
    "Extract and validate schema.org JSON-LD on a page (tolerates arrays and @graph). Checks Organization (incl. sameAs links), SoftwareApplication (name/description/applicationCategory/offers), FAQPage (Question/acceptedAnswer structure), and BreadcrumbList. Flags malformed JSON-LD blocks and provides a ready-to-paste Organization example when none exists.",
  urlDescription: "Page URL to analyze",
  audit: (url) => auditStructuredData(url),
});

registerUrlCheck("check_ai_crawlers", {
  title: "Check AI crawler access & indexability",
  description:
    'Report the effective robots.txt allow/block status for GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot, and the * default (flagging blanket Disallow: / without per-bot overrides). Checks for /llms.txt, and flags noindex/nofollow in both the X-Robots-Tag response header and <meta name="robots"> — critical failures invisible to a plain robots.txt check.',
  urlDescription: "Page URL to check (robots.txt/llms.txt are checked at its origin)",
  audit: (url) => auditAiCrawlers(url),
});

/* ------------------------------------------------------------------ *
 * Tools with bespoke input shapes
 * ------------------------------------------------------------------ */

registerTool(
  "check_url_structure",
  {
    title: "Check clean-URL rules",
    description:
      "Analyze one or more URLs against clean-URL best practices: ≤ ~60 chars, lowercase, hyphens not underscores, no accents/special chars, no messy query params, shallow hierarchy. Offline — no requests are made.",
    inputSchema: {
      urls: z
        .array(urlSchema("A URL to analyze"))
        .min(1, "Provide at least one URL")
        .max(500, "Analyze at most 500 URLs per call")
        .describe("URLs to analyze"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ urls }) => ok(auditUrlStructure(urls))
);

registerTool(
  "check_keyword_placement",
  {
    title: "Check on-page keyword placement",
    description:
      "Analyze where target keywords appear on a page: <title> (and whether it's front-loaded), URL path, meta description, H1, H2 subheadings, first ~100 words, image alt text, and keyword density (flags both thin usage and stuffing). Matching is plural/stem-tolerant ('freight broker' matches 'freight brokers'). Pass keywords as an array (one report section per keyword); a single keyword string is also accepted. Returns ✅/⚠️/❌ per placement.",
    inputSchema: {
      url: urlSchema("Page URL to analyze"),
      keywords: z
        .array(z.string().trim().min(1).max(200))
        .max(25, "Analyze at most 25 keywords per call")
        .optional()
        .describe("Target keywords/phrases — one report section each"),
      keyword: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Single keyword (backward-compatible alternative to keywords)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, keywords, keyword }) => {
    // De-duplicate so passing the same term twice doesn't produce two sections.
    const list = [
      ...new Set([...(keywords ?? []), ...(keyword ? [keyword] : [])].map((k) => k.trim()).filter(Boolean)),
    ];
    if (!list.length)
      return ok(fail("Provide `keywords` (an array of phrases) or `keyword` (a single phrase) to analyze."));

    const target = assertFetchableUrl(url).href;
    const page = await getPage(target); // fetch once, share across keywords
    const reports = [];
    for (const k of list) reports.push(await auditKeywordPlacement(target, k, page));
    return ok(reports.join("\n\n"));
  }
);

registerTool(
  "run_lighthouse",
  {
    title: "Run Lighthouse (Core Web Vitals)",
    description:
      "Run Google Lighthouse (performance + SEO categories) on a URL via npx. Reports scores and Core Web Vitals — LCP (≤ 2.5s), CLS (≤ 0.1), and INP (≤ 200ms; falls back to TBT when the lab run can't measure interactions) — plus top speed opportunities. Slow (~1-2 min); requires Chrome installed.",
    inputSchema: {
      url: urlSchema("Page URL to measure"),
      form_factor: z
        .enum(["mobile", "desktop"])
        .default("mobile")
        .describe("mobile (default, matches Google's mobile-first indexing) or desktop"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, form_factor }, extra) => {
    const target = assertFetchableUrl(url).href;
    const reportProgress = progressReporter(extra, 1);
    await reportProgress(0, `Running Lighthouse on ${target} (this takes 1–2 minutes)`);
    try {
      const result = await runLighthouse(target, form_factor, { signal: extra?.signal });
      await reportProgress(1, "Lighthouse complete");
      return ok(result);
    } catch (err) {
      // Lighthouse has many environment-specific failure modes; surface the
      // reason plus a manual repro command rather than a bare stack.
      log.warn("Lighthouse failed", { url: target, err });
      return ok(
        fail(
          `Lighthouse failed: ${describeError(err, { url: target })}\n` +
            `Verify Chrome is installed and try manually: npx lighthouse ${target} --only-categories=performance,seo`
        )
      );
    }
  }
);

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Without these handlers an unexpected rejection would print a raw stack and
 * kill the process, which an MCP client sees only as a dropped connection.
 */
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", { err: reason instanceof Error ? reason : new Error(String(reason)) });
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception — shutting down", { err });
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Shutting down", { signal });
  try {
    await server.close();
  } catch (err) {
    log.warn("Error while closing server", { err });
  }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void shutdown(sig));

const transport = new StdioServerTransport();
await server.connect(transport);
log.info("Server ready", { name: SERVER_NAME, version: VERSION, transport: "stdio", tools: TOOL_SUMMARY.length });
