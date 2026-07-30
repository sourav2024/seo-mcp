# Support

## Where to go

| I want to…                        | Go here                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Understand a feature or set it up | [README](README.md) — installation, configuration, troubleshooting, FAQ                              |
| Report a bug                      | [Bug report](https://github.com/sourav2024/seo-mcp/issues/new?template=bug_report.yml)               |
| Request a check or feature        | [Feature request](https://github.com/sourav2024/seo-mcp/issues/new?template=feature_request.yml)     |
| Ask a question or share an idea   | [Discussions](https://github.com/sourav2024/seo-mcp/discussions)                                     |
| Report a security vulnerability   | [Private advisory](https://github.com/sourav2024/seo-mcp/security/advisories/new) — **not** an issue |
| Contribute code                   | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                   |

## Before opening an issue

Most reports resolve faster with a few details up front:

1. **Check the [troubleshooting section](README.md#troubleshooting)** — connection
   failures, missing Chrome, and permission errors are covered there.

2. **Re-run with debug logging.** This usually shows the cause directly:

   ```json
   { "env": { "SEO_MCP_LOG_LEVEL": "debug", "SEO_MCP_LOG_FORMAT": "text" } }
   ```

3. **Confirm the server itself starts.** This isolates the server from the client:

   ```bash
   npx -y technical-seo-mcp --version
   npm run smoke   # from a clone
   ```

4. **Include the audited URL** when the site is public. A check that misbehaves on
   a real page is far easier to fix than a described one.

## What to include in a bug report

- `technical-seo-mcp` version (`npx technical-seo-mcp --version`)
- Node.js version (`node --version`) and OS
- Your MCP client and version
- The tool you called and its arguments
- What you expected, and what happened
- Debug-level server logs, with anything sensitive removed

## Response expectations

This is a volunteer-maintained open-source project. Issues are usually triaged
within about a week. Security reports are prioritized — see
[SECURITY.md](SECURITY.md) for that timeline.

Clear, reproducible reports get fixed. Reports that cannot be reproduced may be
closed after a request for more detail goes unanswered; reopening with new
information is always welcome.

## Commercial support

None is offered. The project is MIT-licensed, so you are free to fork it and
adapt it to your needs.
