# Contributing

Thanks for considering a contribution. This project aims to be a dependable,
low-dependency tool, so the bar for new code is "does it earn its keep."

## Quick start

```bash
git clone https://github.com/sourav2024/seo-mcp
cd seo-mcp
npm install
npm run verify     # lint + tests + MCP protocol smoke test
```

Requires **Node.js 20.10+**. There is no build step — the project is plain ESM
and runs directly.

## Development workflow

```bash
npm test              # unit + fixture tests
npm run test:watch    # re-run on change
npm run smoke         # drive the real MCP protocol over stdio
npm run lint          # Prettier check
npm run format        # Prettier write
npm run verify        # everything CI runs
```

### Testing against a real client

Point your MCP client at your working copy:

```bash
claude mcp add seo-dev -- node "$PWD/server.js"
```

Set `SEO_MCP_LOG_LEVEL=debug` and `SEO_MCP_LOG_FORMAT=text` while developing —
you get per-request timings, byte counts, and full stacks in readable form.

## Project layout

```text
server.js              MCP tool registration only — no audit logic
src/
  config.js            All tunables; validated env vars with safe defaults
  logger.js            Structured stderr logging with redaction
  url-guard.js         URL validation and SSRF/private-host checks
  tool-result.js       MCP result shapes and error-message mapping
  version.js           Version and identity constants
checks/
  index.js             Registry — re-exports every check
  helpers.js           Shared fetch, redirect walking, stemming, parsing
  <check>.js           One audit function per checklist section
  report.js            markdown/JSON/HTML output + baseline diffing
  html-report.js       Standalone HTML renderer
test/                  node:test suites
scripts/smoke.js       End-to-end MCP protocol check
```

The important boundary: **`server.js` never contains audit logic, and `checks/`
never touches the MCP protocol.** Keeping them separate is what makes the checks
directly unit-testable.

## Adding a new check

1. Create `checks/your-check.js` exporting an `async function auditYourCheck(url, page)`.
   - Accept the optional prefetched `page` and pass it to `getPage(url, page)` so
     `crawl_audit` can share a single fetch across checks.
   - Return a Markdown string whose first line is `## Section title`.
   - Mark each finding with `pass()`, `warn()`, or `fail()` from `helpers.js`.
2. Re-export it from `checks/index.js`.
3. Register it in `server.js` — use `registerUrlCheck()` if it takes just a URL.
4. Add a fixture test in `test/fixtures.test.js`: serve a deliberately broken page
   from the local `node:http` server and assert the right severity is produced.
5. Document it in the README tool table and add a CHANGELOG entry.

### What makes a good check

- **Actionable.** Say what is wrong _and_ how to fix it. Where a snippet helps
  (a `robots.txt` block, an Organization JSON-LD example), include it.
- **Correctly severe.** `fail` for things that actively harm indexing or ranking;
  `warn` for genuine improvements; `pass` when it is fine. Inflating severity
  makes the whole report less useful.
- **No false positives.** A check that cries wolf on valid setups is worse than
  no check. When a signal is ambiguous, `warn` and say what to verify manually.

## Code style

Prettier is the only formatter, and `npm run lint` gates CI. Beyond that:

- **Comments explain _why_, never _what_.** The code already says what it does.
  A comment earns its place by capturing a constraint, a trade-off, or a
  non-obvious reason — the kind of thing a reader would otherwise have to
  rediscover. Skip narration.
- **No new runtime dependencies** without discussion. Two is a feature; the
  standard library covers most needs.
- **Named constants over magic values**, defined near the top of the module or in
  `src/config.js` if a user might want to tune it.
- **All tunables go through `src/config.js`** so they are validated and documented
  in one place. Do not read `process.env` in a check.
- **Never write to stdout.** It carries the MCP protocol. Use `log` from
  `src/logger.js`, which writes to stderr.
- **Errors must be actionable.** Add new failure modes to `describeError()` in
  `src/tool-result.js` rather than letting a raw Node code surface.

## Pull requests

- Branch from `main`.
- Keep PRs focused; unrelated changes are easier to review separately.
- Run `npm run verify` before pushing.
- Include tests for behavior changes and bug fixes. For a bug fix, a test that
  fails before your change is the most valuable thing you can add.
- Update the README and CHANGELOG when behavior changes.
- Describe _why_ the change is needed, not only what it does.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
loosely — `fix:`, `feat:`, `docs:`, `test:`, `refactor:`, `chore:`. It is a
convention here, not an enforced gate.

## Reporting bugs

Please use the [bug report template](https://github.com/sourav2024/seo-mcp/issues/new?template=bug_report.yml)
and include the URL you audited when the site is public. A reproducible URL turns
a guess into a fix.

For false positives or false negatives in a check, say what the tool reported and
what you expected — that framing makes the disagreement precise.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Releasing

Maintainer-only: see [docs/releasing.md](docs/releasing.md).

## License

Contributions are licensed under the [MIT License](LICENSE), matching the project.
