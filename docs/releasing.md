# Releasing

Steps for cutting a release to npm and GitHub. Written for the maintainer.

## One-time setup

Do these once, before the first publish.

- [ ] **npm account** — `npm login` (username: `sourav28`). Verify with `npm whoami`.
- [ ] **GitHub repo** created at `github.com/sourav2024/seo-mcp`, with a remote:
      `git remote add origin https://github.com/sourav2024/seo-mcp.git`
- [ ] **`NPM_TOKEN`** added as a repository secret (Settings → Secrets → Actions),
      using an **Automation** token so it bypasses 2FA in CI.
- [ ] **`release` environment** created (Settings → Environments) — `release.yml`
      references it.
- [ ] **Discussions enabled** (Settings → Features) — linked from SUPPORT.md and
      the issue templates.
- [ ] **GitHub Sponsors** enrolled at [github.com/sponsors](https://github.com/sponsors).
      The repo already declares it (`.github/FUNDING.yml`, `package.json` `funding`,
      README badge) — the button and links simply stay inert until approval, so
      publishing before enrollment completes is fine.

## Pre-flight

```bash
npm run verify        # lint (Prettier + markdownlint) + 106 tests + MCP smoke test
npm pack --dry-run    # confirm the file list: no tests, docs, images, or CI config
```

Also confirm:

- [ ] `CHANGELOG.md` has an entry for this version, and `## [Unreleased]` is empty
- [ ] `package.json` `version` matches the tag you're about to create
- [ ] `server.json` `version` **and** its `packages[0].version` match too
      (the MCP Registry validates this)

## Publish

The tagged release workflow does this automatically. To publish manually:

```bash
npm publish --access public     # prepublishOnly runs the placeholder check + tests
```

Then tag and push:

```bash
git tag v1.0.0
git push origin main --tags
```

`release.yml` verifies the tag matches `package.json`, runs the full
verification, publishes with provenance, and creates the GitHub release.

## Post-publish

- [ ] `npx -y technical-seo-mcp@latest --version` — proves the real registry path
      works, which is the one thing a local tarball cannot validate
- [ ] Register the server in a client from the published package, not a clone:
      `claude mcp add technical-seo -- npx -y technical-seo-mcp`
- [ ] Run one real audit end to end
- [ ] Submit to the [MCP Registry](https://registry.modelcontextprotocol.io)
      using `server.json`
- [ ] Optionally submit to `mcpservers.org`, Smithery, Glama, PulseMCP, and
      Awesome MCP Servers

## Funding

Configured for **GitHub Sponsors** (`sourav2024`) in three places:

| File                     | Effect                                          |
| ------------------------ | ----------------------------------------------- |
| `.github/FUNDING.yml`    | Sponsor button at the top of the repo           |
| `package.json` `funding` | Funding link on the npm page; powers `npm fund` |
| README badge + section   | Visible on GitHub and npm                       |

Nothing breaks if enrollment is still pending — GitHub hides the button until the
account is approved, and the links resolve to a normal GitHub page.

Two notes:

- The **fiscal-host choice is fixed at signup**; changing it later requires
  contacting GitHub Support. For an individual in India, bank transfer via Stripe
  Connect is the normal path.
- **Buy Me a Coffee is not usable from India** (Stripe-only payouts, India not in
  its 48 supported countries), and **Buy Me a Chai is UPI-only**, so it cannot
  accept payments from developers outside India. GitHub Sponsors is the only
  option that both accepts international payers and pays into an Indian bank.

## Versioning

See the [versioning strategy](../CHANGELOG.md#versioning-strategy). In short:
removing or renaming a tool or parameter is a **major**; adding a tool, an
optional parameter, or a new check is a **minor**; fixes and false-positive
corrections are a **patch**.
