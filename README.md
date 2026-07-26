# seo-mcp — Technical & On-Page SEO Audit MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that audits any website against a technical SEO checklist plus on-page keyword placement. Works with any MCP client — Claude Code, Claude Desktop, Cursor, etc. No API keys required; all checks run against the live site over plain HTTP.

Built with `@modelcontextprotocol/sdk` (stdio transport) and Node.js — zero heavy dependencies (only `zod` for input schemas). Lighthouse runs on demand via `npx`.

## What it covers

### Technical SEO

| Tool | Checks |
|---|---|
| `seo_full_audit` | Runs everything below (except Lighthouse) in one Markdown report with ✅/⚠️/❌ per item |
| `check_rendering` | Fetches the page **without JavaScript** and detects client-side JS shells that Google/AI crawlers struggle to read — recommends SSR/SSG when needed |
| `check_https` | Valid SSL certificate on `https://`, and a permanent **301** redirect from `http://` (flags temporary 302/307 redirects) |
| `check_url_structure` | Clean-URL rules: ≤ ~60 chars, lowercase, hyphens not underscores, no accents/special chars, no messy query params (`?id=4582`), shallow hierarchy; reminds you to 301-redirect any renamed URL |
| `check_page_essentials` | `<title>` presence & length, meta description, exactly one `<h1>`, canonical tag, Open Graph tags, responsive viewport meta (mobile-first), image lazy-loading, WebP/AVIF usage |
| `check_caching` | `Cache-Control`, compression (gzip/brotli), `ETag`/`Last-Modified` revalidation, HTML document size |
| `check_sitemap` | `/sitemap.xml` exists, entry count (flags empty sitemaps), and warns on admin/cart/checkout/internal-search URLs that should be excluded |
| `check_robots` | `/robots.txt` exists, references the sitemap, and doesn't accidentally block the entire site (`Disallow: /`) |
| `run_lighthouse` | Google Lighthouse performance + SEO scores, **LCP vs the ≤ 2.5 s target**, and top speed opportunities. Mobile by default (matching Google's mobile-first indexing), `desktop` optional. Slow (~1–2 min); requires Chrome |

### On-page SEO

| Tool | Checks |
|---|---|
| `check_keyword_placement` | Where a target keyword appears: `<title>` (and whether it's front-loaded), URL path, meta description, `<h1>`, `<h2>` subheadings, first ~100 words, image alt text (plus images missing alt entirely), and keyword density — flagging both thin usage (< 0.3%) and stuffing (> 3%), targeting the healthy ~0.5–2% range |

### Not covered (by design)

- **Keyword research** — search volume, difficulty, competitor keywords need external data (Ahrefs, Semrush, Google Keyword Planner APIs)
- **Backlinks / off-page SEO**
- **Rendered-page visual checks** — pair with the [Playwright MCP](https://github.com/microsoft/playwright-mcp) for mobile-viewport screenshots and JS-rendered inspection

## Install

```bash
cd seo-mcp
npm install
```

### Register with Claude Code (available in every project)

```bash
claude mcp add technical-seo --scope user -- node /absolute/path/to/seo-mcp/server.js
```

### Register with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "technical-seo": {
      "command": "node",
      "args": ["/absolute/path/to/seo-mcp/server.js"]
    }
  }
}
```

## Usage

Once registered, just ask your MCP client in plain language:

- *"Run a full technical SEO audit on https://example.com"* → `seo_full_audit`
- *"Check keyword placement for 'freight broker software' on https://truxo.ai"* → `check_keyword_placement`
- *"Is https://example.com's LCP under 2.5 seconds on mobile?"* → `run_lighthouse`
- *"Are these URLs SEO-friendly?"* → `check_url_structure`

Every tool returns a Markdown report where each check is marked:

- ✅ passing
- ⚠️ worth improving
- ❌ needs fixing (with the concrete fix, e.g. a ready-to-paste `robots.txt`)

## Example output

```
# Technical SEO audit — https://truxo.ai

## HTTPS / SSL
✅ https:// serves with a valid certificate (HTTP 200).

## Page essentials (metadata, mobile-first, images)
✅ <title> present (40 chars): "Truxo | TMS for Freight Brokers & Fleets"
⚠️ Only 11/77 images lazy-loaded — enable lazy loading.

## Caching & delivery headers
⚠️ No Cache-Control header — enable page/browser caching for a dramatic speed boost.

## Sitemap
⚠️ https://truxo.ai/sitemap.xml exists but contains 0 <loc> entries...
```

## Development

```bash
# Smoke-test over stdio without a client
(printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2) | node server.js
```

All checks live in `server.js` — one `audit*` function per cheat-sheet section, one `server.registerTool(...)` per tool.
