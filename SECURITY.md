# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

Security fixes land on the latest minor release. There are no long-term support
branches for older minors.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/sourav2024/seo-mcp/security/advisories/new),
which creates a confidential thread with the maintainers.

Please include:

- A description of the issue and its impact
- Steps to reproduce (a minimal case is ideal)
- The version of `technical-seo-mcp` and Node.js you tested
- Any suggested fix

**What to expect:**

- Acknowledgement within 5 business days
- An assessment and planned fix timeline within 10 business days
- Credit in the release notes, unless you prefer to remain anonymous

This is a volunteer-maintained project, so there is no paid bug bounty.

## Threat model

Understanding what this tool does is essential to assessing its risk.

`technical-seo-mcp` is a **local, stdio-transport MCP server**. It is launched as
a subprocess by an MCP client (Claude Code, Claude Desktop, Cursor, …) on the
user's own machine, and it makes outbound HTTP requests to URLs the user supplies.

**Trusted inputs, by design:**

- The URLs passed to tools. They come from the user or from an LLM acting on the
  user's behalf.
- The environment variables that configure the server.

**Untrusted inputs, treated as hostile:**

- Everything fetched from the network: HTML, headers, `robots.txt`, `sitemap.xml`,
  JSON-LD, and redirect targets. An audited site can be malicious or compromised,
  and content from it flows into reports, filenames, and parsers.

### What is defended

| Risk                    | Mitigation                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Command injection**   | Lighthouse is spawned with `execFile` and `shell: false` on every platform. On Windows, `npx.cmd` runs via `cmd.exe /c` with a separate argument array, so URL metacharacters cannot break out. URLs are validated before being passed as arguments.                  |
| **SSRF**                | Only `http:`/`https:` are fetchable. Redirects are followed manually and re-validated on every hop. Setting `SEO_MCP_ALLOW_PRIVATE_HOSTS=false` blocks RFC1918, loopback, link-local (including `169.254.169.254`), CGNAT, multicast, and IPv4-mapped IPv6 addresses. |
| **XSS in reports**      | All page-derived text and the target URL are HTML-escaped in HTML reports. Reports contain no `<script>`, no `src=`, and no CSS `url()`, so an audited page cannot execute code in a report opened locally.                                                           |
| **Path traversal**      | Baseline filenames are built from a `[a-z0-9-]`-whitelisted slug plus a SHA-256 hash, so no `/`, `\`, or `..` from a URL can reach the filesystem path.                                                                                                               |
| **Prototype pollution** | Maps keyed by page-derived strings use `Object.create(null)`. Parsed baseline JSON is copied onto a null-prototype object before use.                                                                                                                                 |
| **Memory exhaustion**   | Response bodies are capped (`SEO_MCP_MAX_BODY_BYTES`, default 10 MB). JSON-LD traversal is depth-, count-, and cycle-limited. Log fields are truncated and cycle-aware.                                                                                               |
| **Resource exhaustion** | Every request has a timeout. Redirect chains are hop-limited and loop-detecting. Crawls are page-capped and rate-limited.                                                                                                                                             |
| **Credential leakage**  | Logs redact sensitive field names and strip userinfo and credential-bearing query parameters from URLs. The server has no API keys or secrets of its own.                                                                                                             |
| **Stream/socket leaks** | Response readers are released in a `finally` block, so an early exit cannot pin a socket for the life of a crawl.                                                                                                                                                     |

### Known limitations

These are accepted trade-offs, not oversights.

1. **Private hosts are reachable by default.** `SEO_MCP_ALLOW_PRIVATE_HOSTS`
   defaults to `true` because auditing `localhost:3000` or an internal staging
   host is a primary use case. In the intended deployment — a local server whose
   URLs come from the user — this is the correct default. **If you expose this
   server to input you do not control, set it to `false`.**

2. **No DNS-rebinding protection.** Host checks run against the hostname and any
   literal IP, not against the resolved address at connect time. A hostname that
   resolves to a private address will still be fetched even with
   `SEO_MCP_ALLOW_PRIVATE_HOSTS=false`. Closing this properly requires resolving
   and pinning the address before connecting; it is tracked for a future release.

3. **HTTP transport is not supported.** The server is stdio-only. Do not put it
   behind an HTTP endpoint without adding host allowlisting and authentication —
   arbitrary-URL fetching becomes a serious SSRF vector in a shared deployment.

4. **`run_lighthouse` downloads code at runtime.** It invokes `npx lighthouse`,
   which fetches the Lighthouse package from the npm registry on first use. If
   your threat model excludes runtime package downloads, avoid that one tool;
   the other twelve make no such call.

5. **HTML reports are written to disk.** `output: "html"` writes to the current
   working directory by default. Reports contain audited-site content (escaped,
   but present), so treat them as you would any downloaded page.

### Dependency advisories

`npm audit` currently reports two moderate advisories for `@hono/node-server`, a
transitive dependency of `@modelcontextprotocol/sdk`:

- **Not exploitable here.** The advisory concerns path traversal in Hono's
  `serve-static` on Windows. This server uses the **stdio** transport exclusively;
  the HTTP transport that pulls in Hono is never imported, and no static files
  are served. Loading `server/stdio.js` pulls in zero Hono modules.
- **`npm audit fix` would downgrade the SDK** from 1.29.0 to 1.24.3, losing
  upstream fixes to gain nothing. We deliberately do not do this.
- The advisory clears when the MCP SDK bumps its own dependency upstream.

Verify the claim yourself:

```bash
npm ls @hono/node-server   # shows it under @modelcontextprotocol/sdk
```

## Hardening checklist

For a locked-down deployment:

```bash
SEO_MCP_ALLOW_PRIVATE_HOSTS=false   # block private/loopback/metadata targets
SEO_MCP_MAX_BODY_BYTES=2097152      # tighter body cap (2 MB)
SEO_MCP_FETCH_TIMEOUT_MS=10000      # fail faster
SEO_MCP_CRAWL_MAX_PAGES=25          # bound crawl cost
SEO_MCP_LOG_LEVEL=warn              # less log volume
```

Avoid `run_lighthouse` if runtime package downloads or spawning a browser are
unacceptable in your environment.
