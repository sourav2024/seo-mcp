# Reporting results

Write for the person who has to act on it. Lead with the answer, keep passing
checks out of the way, and tie every recommendation to a place to change it.

## In the conversation

```markdown
**Verdict:** <one sentence — e.g. "The page can't rank yet: it's marked noindex
by an X-Robots-Tag header from the CDN.">

**Blockers** (fix first — nothing else matters until these are gone)

1. <finding> — <why it matters, in one clause> → <file / setting to change>

**High impact**

2. …

**Worth doing**

3. …

**Verified:** <what was re-audited and now passes>
**Needs a deploy to take effect:** <redirects, CDN headers, DNS — anything not
testable locally>
```

Rules:

- Number the fixes in the order they should be done.
- Name the file, setting, or dashboard for each — "`app/layout.tsx`, root
  `metadata`", not "update your metadata".
- Group a site-wide issue once ("all 24 crawled pages: no canonical — fix in
  the root layout"), never once per page.
- Mention passing areas in one line at most ("HTTPS, robots.txt, and the
  sitemap are fine").
- Quote numbers from the tools exactly (LCP 3.8 s, 11/40 images missing alt).
  Don't round a fail into a pass.
- No ranking or traffic promises, and no timelines for re-indexing; say
  "Google re-crawls on its own schedule; requesting indexing in Search Console
  can speed it up."

## For a client or manager

Run the audit with `output: "html"` (add `output_path` to choose where it goes)
and send the file — it's self-contained, works offline, and prints cleanly.
Put the conversation summary above in the message alongside it: the HTML file
lists findings, while your summary supplies the priorities and the plan.

For a before/after story, run with `compare_to_baseline: true` before the work
starts and again after; the "Changes since last baseline" section lists every
new failure and every fixed item.
