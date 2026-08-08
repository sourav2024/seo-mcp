# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [1.1.0] — 2026-08-08

### Added

- **`check_hreflang` — international SEO.** Validates a page's hreflang cluster:
  BCP-47 value shape (catching `en_US`, `en-UK`, `en-EU` and other common
  mistakes), a required self-referencing annotation, `x-default` presence,
  duplicate or conflicting values, relative `href`s, and agreement with
  `<html lang>`. Comparing only the language subtag means `<html lang="en">`
  alongside `hreflang="en-US"` is correctly treated as idiomatic, not a mismatch.

  With `verify_return_links: true` it fetches each alternate (capped by
  `max_alternates`, default 10) and confirms reciprocity — **a missing return
  link is the most common reason Google ignores an otherwise-correct cluster**,
  and it cannot be detected from a single page. Off by default because it costs
  one request per alternate.

  A single-language site is told hreflang simply isn't needed, rather than being
  reported as broken.

  The tool is included in `seo_full_audit` (without return-link verification, to
  keep the full audit single-page), bringing the server to **14 tools**.

### Fixed (pre-release)

- **`check_hreflang` reported valid lowercase values as invalid.** hreflang is
  case-insensitive per spec, and real sites ship `de-de` and `en-us` — GitLab's
  entirely correct cluster is all-lowercase, and the shape test failed six of its
  valid annotations. Values are now normalised to canonical casing before the
  shape test, while the lowercase forms of genuine mistakes (`en-uk`, `en_us`)
  are still caught.

## [1.0.0] — 2026-07-27

First public release.

The items below marked **(pre-release fix)** were found during a pre-release
review of the unpublished code. They are recorded because they document real
defects and deliberate design decisions, not because any published version
exhibited them.

### Fixed (pre-release)

- `check_url_structure` threw a raw `TypeError` on any unparsable URL, discarding
  the results for every other URL in the batch — and because `seo_full_audit`
  called it outside its error boundary, a fully successful audit could return
  nothing. Each URL is now evaluated independently.
- A full audit made 8 HTTP requests, fetching the page 3× and `robots.txt` 2×.
  Checks now share a prefetched page and an origin-resource cache: **5 requests**,
  one per distinct URL.
- The crawler keyed its status bookkeeping on raw URL strings while link
  extraction returned normalized ones, so `http://host` never matched
  `http://host/`. Every crawl re-fetched its own start page during the
  broken-link pass, and near-duplicate paths could be reported as false orphans.
- `SEO_MCP_CRAWL_CONCURRENCY` was validated, logged, and documented but never
  used — the crawl was unconditionally serial. It now drives a worker pool that
  preserves BFS link discovery and the per-fetch politeness delay.
- `auditHttps` downloaded the full page body to test a certificate and never
  consumed the redirect-probe response, leaking a socket per call. It now uses
  `HEAD`, and reuses the shared page when the audited URL is already `https://`.
- HTML reports failed with `ENOENT` when `output_path` named a directory that did
  not exist yet; missing directories are now created.
- An unrecognized CLI flag silently started the stdio server, so a typo looked
  like a hang and `--transport=http` appeared to be accepted. Unknown arguments
  now print usage to stderr and exit 2.
- Five more checks (`auditSitemap`, `auditRobots`, `auditAiCrawlers`,
  `auditHttps`, `auditKeywordPlacement`) threw a raw `TypeError` on malformed
  URLs when imported directly as a library — the same defect class as
  `check_url_structure`, one layer down. All URL parsing now goes through
  `parseUrlOrThrow`, which raises a typed, actionable `UrlValidationError`.
- Hostname validation was missing: the WHATWG URL parser accepts hosts DNS never
  will, so a mistyped scheme (`ht!tp://x`) became the host `ht!tp` and surfaced
  minutes later as an opaque `fetch failed`. Invalid hostnames are now rejected
  up front, with IPv6 literals and IDN punycode still accepted.
- Three broken relative links in the extracted troubleshooting doc, and an
  unused `okStructured` helper left behind when `structuredContent` moved into
  `finishReport`.

### Added (pre-release)

- **Progress notifications** — pass a `progressToken` and `seo_full_audit`,
  `crawl_audit`, and `run_lighthouse` report incremental progress instead of
  leaving the client on a frozen spinner for minutes.
- **Cancellation** — cancelling a request stops a crawl between pages and
  terminates the Lighthouse child process rather than running to completion.
- **`structuredContent`** on `output: "json"`, so clients can consume the result
  object without re-parsing a string. (No `outputSchema` is declared: the SDK
  enforces one on every result, which would break the markdown and html modes.)
- HTML reports fall back to a reports directory under the state dir when the
  working directory is implausible — a GUI-launched MCP server often inherits
  `/`, where a written report would never be found.
- `server.json` for the official MCP Registry.
- Tests for `crawl.js` — previously the largest untested module — plus CLI
  behavior, covering BFS discovery under concurrency and the fetch-once guarantee.
- `--help` now derives its tool list from a single source, so the count cannot
  drift from what is registered.

### Added

**13 MCP tools**

- `seo_full_audit` — the full checklist against one URL in a single report
- `crawl_audit` — multi-page crawl with site-wide issue aggregation, broken-link
  detection, redirect chains, duplicate titles/descriptions, and orphan sitemap URLs
- `check_rendering` — server-rendered HTML vs. client-side JS shell
- `check_https` — certificate validity and `http:` → `https:` 301 redirect
- `check_url_structure` — clean-URL rules (offline; makes no requests)
- `check_page_essentials` — title, meta description, single `h1`, canonical,
  Open Graph, viewport, image lazy-loading, WebP/AVIF, and CLS-risk dimensions
- `check_caching` — `Cache-Control`, compression, `ETag`/`Last-Modified`, document size
- `check_sitemap` — existence, entry count, sampled `<loc>` verification, `lastmod` freshness
- `check_robots` — validity, sitemap reference, accidental site-wide blocks
- `check_keyword_placement` — placement and density with plural/stem-tolerant matching
- `check_structured_data` — JSON-LD validation for Organization, SoftwareApplication,
  FAQPage, and BreadcrumbList
- `check_ai_crawlers` — per-bot robots status (GPTBot, ClaudeBot, Google-Extended,
  PerplexityBot, CCBot), `llms.txt`, and `noindex` in both header and meta tag
- `run_lighthouse` — Core Web Vitals (LCP, CLS, INP with TBT fallback)

**Output formats**

- Markdown (default), JSON for CI pipelines, and a standalone HTML report
- HTML reports inline all CSS and fetch nothing, so they work offline, over
  `file://`, and as email attachments; light/dark aware and print-friendly
- `output_path` to control where the HTML file is written
- `compare_to_baseline` to diff an audit against the previous run for the same
  target, reporting new failures, new warnings, and fixed items

**Configuration**

- Every tunable is an optional, validated environment variable — see
  [`.env.example`](.env.example). Invalid values fall back to the documented
  default with a warning instead of crashing.
- Baselines are stored per target under the OS state directory, overridable with
  `SEO_MCP_STATE_DIR`

**Operations**

- Structured JSON logging to stderr (never stdout, which carries the MCP
  protocol), with automatic redaction of credentials in URLs and sensitive
  field names
- Tool failures return `isError: true` results rather than protocol errors, so
  the model can read and react to them
- `--help` and `--version` flags
- `npm run smoke` drives the real MCP wire protocol end to end

### Security

- URL validation restricts fetches to `http:`/`https:`, blocking `file:`,
  `data:`, and other schemes
- Redirects are followed manually and re-validated at every hop, so a public URL
  cannot redirect into a private range unchecked
- Optional SSRF protection via `SEO_MCP_ALLOW_PRIVATE_HOSTS=false`, covering
  RFC1918, loopback, link-local (including the `169.254.169.254` cloud-metadata
  address), and IPv4-mapped IPv6 forms
- Lighthouse is spawned without a shell on every platform, so a URL containing
  shell metacharacters cannot inject a command on Windows
- HTML reports escape all page-derived content, preventing script injection from
  an audited page into a locally opened report
- Baseline maps use null-prototype objects, so a page containing `__proto__`
  cannot pollute the prototype chain
- Response bodies are capped (default 10 MB) and JSON-LD traversal is depth-,
  count-, and cycle-limited

See [SECURITY.md](SECURITY.md) for the threat model and known limitations.

---

## Versioning strategy

This project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).
Because the public interface of an MCP server is the set of tools it exposes,
versions are interpreted as follows.

### MAJOR (`2.0.0`)

Breaking changes to the contract a client depends on:

- Removing or renaming a tool
- Removing or renaming an input parameter, or making an optional one required
- Removing an enum value from an existing parameter
- Changing the shape of `output: "json"` in a way that breaks existing parsers
- Raising the minimum Node.js version

### MINOR (`1.1.0`)

Backward-compatible additions:

- New tools
- New optional parameters, or new enum values on an existing parameter
- New checks inside an existing tool's report
- New configuration variables with safe defaults

Note that adding a check can change the pass/warn/fail counts for a site that
has not changed. That is expected, and is why a baseline diff after an upgrade
may show new findings.

### PATCH (`1.0.1`)

- Bug fixes, false-positive and false-negative corrections
- Wording, documentation, and performance improvements
- Dependency updates with no interface change

### Deprecation policy

A tool or parameter slated for removal is first marked deprecated in its
description and in this changelog for at least one minor release. Deprecated
inputs keep working until the next major version — `check_keyword_placement`'s
singular `keyword` parameter is an example of a shape kept for compatibility
alongside the preferred `keywords` array.

[Unreleased]: https://github.com/sourav2024/seo-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/sourav2024/seo-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/sourav2024/seo-mcp/releases/tag/v1.0.0
