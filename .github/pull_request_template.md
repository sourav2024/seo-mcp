<!--
Thanks for contributing. Keep this PR focused on one change where possible —
unrelated changes are easier to review separately.
-->

## What and why

<!-- What does this change, and what problem does it solve? Link any related issue. -->

Closes #

## Type of change

- [ ] Bug fix (a check reported the wrong result, or something crashed)
- [ ] New check inside an existing tool
- [ ] New tool
- [ ] Documentation
- [ ] Refactor / internal cleanup (no behavior change)
- [ ] Breaking change (removes or renames a tool or parameter)

## How this was verified

<!-- Not just "tests pass" — say what you actually exercised. -->

- [ ] `npm run verify` passes (lint + tests + MCP smoke test)
- [ ] Added or updated tests covering this change
- [ ] Tried it against a real MCP client
- [ ] Tested against a live site (which one, if public: )

## Checklist

- [ ] New tunables go through `src/config.js` and are documented in `.env.example`
- [ ] No new runtime dependencies (or the PR explains why one is needed)
- [ ] Nothing writes to stdout (it carries the MCP protocol — use `log` from `src/logger.js`)
- [ ] New failure modes produce actionable messages via `describeError()`
- [ ] README updated if user-facing behavior changed
- [ ] CHANGELOG entry added under `## [Unreleased]`

## For a new or changed check

<!-- Delete this section if it does not apply. -->

- **Severity rationale:** why each finding is fail / warn / pass
- **False-positive risk:** what valid setups might trip this, and how it avoids them

## Notes for reviewers

<!-- Anything you are unsure about, or would like a second opinion on. -->
