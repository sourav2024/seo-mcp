# Troubleshooting & FAQ

Common problems, their causes, and answers to recurring questions.
For installation and configuration, see the [README](../README.md).

## Troubleshooting

### The server doesn't appear in my client

```bash
npx -y technical-seo-mcp --version   # does it start at all?
```

Then check your client's MCP logs (in Claude Code: `/mcp`). The most common
causes are a Node version below 20.10 and a typo in the config JSON.

### "Server disconnected" or a startup crash

Run with debug logging in text form:

```json
{ "env": { "SEO_MCP_LOG_LEVEL": "debug", "SEO_MCP_LOG_FORMAT": "text" } }
```

Note that **all logs go to stderr** — stdout carries the MCP protocol, and
anything written there would corrupt the stream.

### `run_lighthouse` fails

```text
❌ Lighthouse failed: no Chrome/Chromium binary found.
```

Install Google Chrome, or point at an existing binary:

```json
{ "env": { "CHROME_PATH": "/path/to/chrome" } }
```

Reproduce outside the server to isolate the problem:

```bash
npx lighthouse https://example.com --only-categories=performance,seo
```

The other 12 tools work fine without Chrome.

### "Baseline could not be saved"

The state directory isn't writable. Point it somewhere that is:

```json
{ "env": { "SEO_MCP_STATE_DIR": "/path/you/can/write" } }
```

The audit still succeeds — only the baseline write failed.

### A site times out mid-audit

```json
{ "env": { "SEO_MCP_FETCH_TIMEOUT_MS": "45000" } }
```

Some sites also block non-browser user agents outright; in that case the audit
reflects what a crawler actually sees, which is itself worth knowing.

### The crawl is too slow, or too aggressive

```json
{ "env": { "SEO_MCP_CRAWL_DELAY_MS": "0", "SEO_MCP_CRAWL_CONCURRENCY": "4" } }
```

Only speed up crawls of sites you own.

### `npm audit` shows advisories

Two moderate advisories come from `@hono/node-server`, a transitive dependency of
the MCP SDK used only by its **HTTP** transport. This server is stdio-only, so
that code never loads, and `npm audit fix` would _downgrade_ the SDK. See
[SECURITY.md](../SECURITY.md#dependency-advisories) for the full analysis.

## FAQ

**Does this need an API key?**
No. Every check runs directly against the live site over HTTP.

**Does it send my data anywhere?**
No. There is no telemetry and no external service. It fetches the URLs you ask
about and writes reports locally.

**Can it audit localhost or a staging site?**
Yes — that's a primary use case. `http://localhost:3000` works out of the box.

**Will it modify my site?**
No. Every tool is read-only (GET requests) and annotated `readOnlyHint`.

**How is this different from Lighthouse or Search Console?**
Lighthouse measures performance on one page; Search Console reports what Google
already found, after a delay. This checks the technical fundamentals on demand
and — because it's an MCP server — lets an assistant go from diagnosis to code
fix in one conversation. `run_lighthouse` wraps Lighthouse for the Core Web Vitals
piece rather than reimplementing it.

**Why are my pass/warn/fail counts different after an upgrade?**
A minor release can add checks, which changes the totals even on an unchanged
site. See the [versioning strategy](../CHANGELOG.md#versioning-strategy).

**Does it execute JavaScript?**
No — deliberately. `check_rendering` exists precisely to tell you what a crawler
sees _without_ JS. For rendered inspection, pair it with Playwright MCP.

**Can I run it as a hosted HTTP service?**
Not as shipped, and it isn't recommended. Arbitrary-URL fetching from a shared
endpoint is a serious SSRF vector. See [SECURITY.md](../SECURITY.md).

**Is the HTML report safe to open?**
Yes. All page-derived content is escaped, and the file contains no scripts and
fetches nothing.
