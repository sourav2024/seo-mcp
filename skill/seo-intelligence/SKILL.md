---
name: seo-intelligence
description: "Diagnose and fix technical and on-page SEO with the technical-seo MCP server — audits, site crawls, Core Web Vitals, sitemaps, robots.txt, structured data, hreflang, keyword placement, and AI-crawler access (GPTBot, ClaudeBot). Use when the user asks why a page isn't ranking or indexed, wants an SEO audit, pre-launch or post-migration check, a client-ready SEO report, Core Web Vitals or Lighthouse numbers, help with sitemap/robots/canonical/schema/hreflang, or wants their site visible to AI search. Goes beyond reporting: maps each finding to the file that causes it and fixes it in the codebase, then re-audits to prove the fix."
license: MIT
compatibility: Needs an agent that supports MCP over stdio, Node.js 20.10+, and network access to the sites being audited. Google Chrome only for Lighthouse.
metadata:
  version: "1.2.1"
  mcp-package: technical-seo-mcp@1.2.1
  source: https://github.com/sourav2024/seo-mcp
---

# SEO Intelligence

Turn "why isn't this ranking?" into a specific, fixed answer. The
`technical-seo` MCP server does the measuring; this skill decides what to run,
how to read the results without over-reacting, and how to fix findings in the
user's own code.

## 1. Make sure the tools are available

Look for tools named `seo_full_audit`, `crawl_audit`, and `check_*` (they may
be prefixed with the server name, e.g. `mcp__technical-seo__seo_full_audit`).

- **Present** — continue to step 2.
- **Missing** — the MCP server is not installed. Show the user the snippet for
  their agent from [references/install.md](references/install.md), ask them to
  add it and restart the agent, then stop. Do not try to imitate the checks
  with ad-hoc `curl` or browser fetches: the report would be incomplete and the
  severities inconsistent with later re-audits.

### What this skill touches (disclosure)

- **The site being audited** — ordinary GET/HEAD requests, identified by the
  user agent `seo-mcp/<version>`. A crawl waits 500 ms between pages by default.
- **registry.npmjs.org** — once, when the agent first launches
  `npx technical-seo-mcp@1.2.1`, and once for `lighthouse@13.5.0` the first
  time `run_lighthouse` is used.
- **Local disk** — only when asked: `output: "html"` writes a report file, and
  `compare_to_baseline: true` saves a baseline in the OS state directory.

Nothing else. No API keys, accounts, telemetry, or third-party SEO services.

## 2. Pick the tool for the question

| The user wants…                                       | Run                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| "Audit this page" / "why isn't it ranking?"           | `seo_full_audit`                                                               |
| The whole site, template-level problems, broken links | `crawl_audit` (`max_pages` 25 by default, up to 100)                           |
| Speed, Core Web Vitals, "is my site slow?"            | `run_lighthouse` (`form_factor: "mobile"` first — Google indexes mobile-first) |
| "Is this page about X?" / content optimisation        | `check_keyword_placement` with `keywords: [...]`                               |
| Visibility in ChatGPT, Claude, Perplexity, Gemini     | `check_ai_crawlers`, then `check_structured_data`                              |
| Multi-country or multi-language site                  | `check_hreflang` with `verify_return_links: true`                              |
| Just one thing (sitemap, robots, canonical, HTTPS…)   | the matching `check_*` tool                                                    |
| URL slugs for new pages, before they exist            | `check_url_structure` (offline, no requests)                                   |
| A report to send to a client or manager               | `seo_full_audit` or `crawl_audit` with `output: "html"`                        |
| "Did my fixes work?" / regression check               | re-run with `compare_to_baseline: true`                                        |

`seo_full_audit` does not include Lighthouse (it takes 1–2 minutes). Run it
separately when performance matters, and say up front that it will be slow.

Local and staging servers (`http://localhost:3000`) work by default — prefer
auditing the local build when the user is changing code, so fixes can be
verified before deploy.

## 3. Read the results like an SEO, not a linter

Severities are ✅ pass, ⚠️ warning, ❌ fail. Triage in this order, because each
tier can make everything below it irrelevant:

1. **Indexability blockers** — `noindex` (meta tag _or_ `X-Robots-Tag` header),
   robots.txt `Disallow: /`, non-200 status, an empty JS shell, or a canonical
   pointing at a different URL. The report only confirms a canonical _exists_,
   so read its `href` yourself when a page is missing from search. A page with
   any of these will not rank no matter what else is fixed. Lead with them.
2. **Crawl and discovery** — sitemap errors, redirect chains, broken internal
   links, HTTPS problems.
3. **Page signals** — title, meta description, single `h1`, structured data,
   keyword placement, hreflang.
4. **Performance** — Core Web Vitals. Real, but rarely the reason a page is
   absent from results entirely.

Judgement calls the raw output can't make for you:

- **Lazy-loading:** never lazy-load the hero / largest above-the-fold image —
  it delays LCP. "Only N images lazy-loaded" is fine when the missing one is
  the LCP image; say so instead of "fixing" it.
- **Empty JS shell on an app behind login:** expected and harmless. It only
  matters on pages meant to rank (marketing, docs, product, blog).
- **AI crawlers blocked:** a business decision, not a bug. Report it neutrally;
  some sites block training crawlers on purpose. `Google-Extended` blocks
  Gemini training without affecting Google Search.
- **Lab vs field Core Web Vitals:** Lighthouse is one simulated mobile run. INP
  usually can't be measured in a lab run — the tool falls back to TBT. Point
  the user to Search Console / CrUX for field data before promising anything.
- **FAQ structured data:** valid schema, but Google shows FAQ rich results only
  for well-known government and health sites. Keep it for AI answers; don't
  promise rich results.
- **Sitemap found but "not declared in robots.txt":** a warning, not a
  failure — Google can still be given the sitemap in Search Console. The fix
  is one `Sitemap:` line in robots.txt, so every other crawler finds it too.
- **Sitemap URLs that redirect:** usually a trailing-slash or casing mismatch
  between the sitemap generator and the router. Fix the generator's URL format
  (or the framework's trailing-slash setting) once, rather than editing entries.
- **Keyword density:** a signal for "is the page about this?", not a target to
  hit. Never recommend repeating a keyword to raise the number.

`crawl_audit` groups issues found on more than half the pages as **site-wide**.
Those live in a shared template, layout, or config — fix them once there, not
page by page.

## 4. Fix it (when there's a codebase)

When the user's project is open, don't stop at the report:

1. **Baseline:** run the audit with `compare_to_baseline: true` so the next run
   can show what changed.
2. **Locate:** map each finding to the file that produces it. Identify the
   framework first, then use [references/fix-recipes.md](references/fix-recipes.md)
   for where titles, canonicals, sitemaps, robots, headers, and JSON-LD live in
   Next.js, Nuxt, Astro, SvelteKit, Remix, Gatsby, WordPress, plain HTML, and
   on Vercel, Netlify, Cloudflare, nginx, and Apache.
3. **Fix** in the template/layout when the issue is site-wide; per page only
   when it's page-specific. Reuse the snippets the report gives (robots.txt,
   Organization JSON-LD) but fill in the real values — never ship placeholder
   names, logos, or URLs.
4. **Verify:** rebuild or restart the dev server, re-run the same audit with
   `compare_to_baseline: true`, and show the user the "Fixed:" lines. If a fix
   only takes effect after deploy (redirects, CDN headers), say so explicitly
   rather than claiming it's done.

Ask before changing anything with ranking risk: robots.txt rules, canonical
targets, redirects, `noindex`, URL slugs of pages that already rank, or the
hreflang cluster.

## 5. Report back

Use [references/report-format.md](references/report-format.md). In short: the
one-sentence verdict first, then blockers, then a prioritised fix list with the
file or setting for each item, then what was verified vs. what needs a deploy.
Never pad with passing checks, and never promise rankings or timelines —
search engines decide those.

## Etiquette and limits

- Crawl sites the user owns or is authorised to audit. For anyone else's site,
  keep `max_pages` small and leave concurrency at the default.
- The checks read raw HTML without running JavaScript (except Lighthouse). For a
  client-rendered SPA, that's exactly what the rendering check exists to reveal.
- If a tool returns an error (timeout, DNS failure, TLS error), report it as a
  finding in its own right — an unreachable page is the most important SEO
  problem of all.
