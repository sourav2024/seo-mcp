# Installing the technical-seo MCP server

The skill drives an MCP server published on npm as
[`technical-seo-mcp`](https://www.npmjs.com/package/technical-seo-mcp)
(MIT, source: <https://github.com/sourav2024/seo-mcp>). Every agent launches it
the same way — `npx -y technical-seo-mcp@1.2.1` over stdio — only the config
file differs.

**Requirements:** Node.js 20.10 or newer (`node --version`). Google Chrome only
if you want `run_lighthouse`; the other 13 tools need nothing else. No API keys.

Ready-made files are in [`../templates/`](../templates/). After adding the
server, **restart the agent** so it picks up the new tools.

## Claude Code

```bash
claude mcp add technical-seo -s user -- npx -y technical-seo-mcp@1.2.1
```

`-s user` makes it available in every project. Check with `claude mcp list`.

## Claude Desktop

Merge [`templates/mcp.json`](../templates/mcp.json) into
`claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## Cursor

Merge [`templates/mcp.json`](../templates/mcp.json) into `~/.cursor/mcp.json`
(all projects) or `.cursor/mcp.json` (this project only).

## VS Code (GitHub Copilot agent mode)

Save [`templates/vscode-mcp.json`](../templates/vscode-mcp.json) as
`.vscode/mcp.json` in the project. Note the top-level key is `servers`, not
`mcpServers`.

## Windsurf

Merge [`templates/mcp.json`](../templates/mcp.json) into
`~/.codeium/windsurf/mcp_config.json`.

## OpenAI Codex CLI

Append [`templates/codex-config.toml`](../templates/codex-config.toml) to
`~/.codex/config.toml`.

## Gemini CLI, Cline, and other MCP clients

Any client that takes an `mcpServers` object accepts
[`templates/mcp.json`](../templates/mcp.json) as-is (Gemini CLI:
`~/.gemini/settings.json`). For anything else: command `npx`, arguments
`-y technical-seo-mcp@1.2.1`, transport stdio.

## Windows

If the client reports that `npx` can't be found or spawned, use
`"command": "cmd"` and put `"/c", "npx"` in front of the other arguments:
`"args": ["/c", "npx", "-y", "technical-seo-mcp@1.2.1"]`.

## Optional settings

Add an `env` object next to `command`/`args` to change these:

| Variable                      | Default  | When to change it                                                            |
| ----------------------------- | -------- | ---------------------------------------------------------------------------- |
| `SEO_MCP_ALLOW_PRIVATE_HOSTS` | `true`   | Set `false` if URLs come from untrusted input — blocks localhost/private IPs |
| `SEO_MCP_FETCH_TIMEOUT_MS`    | `20000`  | Raise for slow sites                                                         |
| `SEO_MCP_CRAWL_DELAY_MS`      | `500`    | Politeness delay between crawled pages                                       |
| `SEO_MCP_CRAWL_CONCURRENCY`   | `1`      | Raise (max 8) only for sites you own                                         |
| `CHROME_PATH`                 | auto     | Chrome installed somewhere unusual                                           |
| `SEO_MCP_LIGHTHOUSE_VERSION`  | `13.5.0` | Pin a different exact Lighthouse release                                     |

## Troubleshooting

- **Tools don't appear:** restart the agent; run
  `npx -y technical-seo-mcp@1.2.1 --version` in a terminal — it should print
  `1.2.1`. If `node` is missing, install Node.js 20.10+.
- **"spawn npx ENOENT" from a desktop app:** GUI apps can inherit a minimal
  `PATH`. Use the absolute path from `which npx` (macOS/Linux) as `command`.
- **`run_lighthouse` fails:** install Google Chrome or set `CHROME_PATH`. The
  first run also downloads Lighthouse, so it is slower.
