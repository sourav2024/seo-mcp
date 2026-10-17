/**
 * Tests for the output layer: HTML rendering, path resolution, and baseline
 * diffing. These run fully offline — no fixture server needed.
 */
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseReport,
  countsOf,
  finishReport,
  renderHtmlReport,
  resolveReportPath,
  reportsDir,
  diffAgainstBaseline,
  diffToMarkdown,
} from "../checks/index.js";

const SAMPLE = `# Technical SEO audit — https://example.com

## Page essentials
❌ No <title> tag found.
⚠️ Two <h1> tags found.
✅ Canonical tag present.

## Robots
✅ robots.txt found.
`;

/* ---------------- HTML rendering ---------------- */

test("html report is self-contained: no external requests", () => {
  const sections = parseReport(SAMPLE);
  const html = renderHtmlReport("https://example.com", sections, countsOf(sections), "2026-07-27 10:00 UTC");
  // No auto-fetched subresources — the file must render fully offline and over
  // file://. Plain <a href> links are fine: the browser only follows them on click.
  assert.doesNotMatch(html, /<script/i, "should contain no scripts");
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i, "should not link external CSS");
  assert.doesNotMatch(html, /<(img|iframe|video|audio|embed|object|source)\b/i, "no embedded media");
  assert.doesNotMatch(html, /\bsrc=/i, "nothing should be auto-fetched");
  assert.doesNotMatch(html, /@import|url\(/i, "CSS must not fetch anything");
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<style>/);
});

test("html report escapes markup in check text (no injection from page content)", () => {
  const evil = `## Page essentials\n❌ Found <script>alert(1)</script> in "<img onerror=x>".`;
  const sections = parseReport(evil);
  const html = renderHtmlReport("https://x.com", sections, countsOf(sections), "now");
  assert.doesNotMatch(html, /<script>alert/, "raw script tag must be escaped");
  assert.match(html, /&lt;script&gt;alert/);
  // The img tag must survive only in escaped form — never as a live attribute.
  assert.doesNotMatch(html, /<img[^>]*onerror/i);
  assert.match(html, /&lt;img onerror=x&gt;/);
});

test("html report escapes the target URL itself", () => {
  const sections = parseReport(SAMPLE);
  const html = renderHtmlReport(`https://x.com/"><script>bad()</script>`, sections, countsOf(sections), "now");
  assert.doesNotMatch(html, /<script>bad/);
});

test("html report shows counts and expands only sections with findings", () => {
  const sections = parseReport(SAMPLE);
  const html = renderHtmlReport("https://example.com", sections, countsOf(sections), "now");
  assert.match(html, /<b>1<\/b><span>Failed<\/span>/);
  assert.match(html, /<b>1<\/b><span>Warnings<\/span>/);
  assert.match(html, /<b>2<\/b><span>Passed<\/span>/);
  // "Page essentials" has findings → open; "Robots" is all-pass → collapsed.
  const essentials = html.slice(html.indexOf("Page essentials") - 200, html.indexOf("Page essentials"));
  assert.match(essentials, /<details class="section" open>/);
  const robots = html.slice(html.indexOf(">Robots<") - 200, html.indexOf(">Robots<"));
  assert.match(robots, /<details class="section">/);
});

test("multi-line fix snippets render as a code block", () => {
  const withSnippet = `## Structured data\n❌ No JSON-LD found. Paste this:\n{"@type": "Organization"}`;
  const sections = parseReport(withSnippet);
  const html = renderHtmlReport("https://x.com", sections, countsOf(sections), "now");
  assert.match(html, /<pre><code>/);
  assert.match(html, /&quot;@type&quot;/);
});

/* ---------------- Path resolution ---------------- */

test("default report path is CWD with a host-and-date slug", () => {
  const p = resolveReportPath("https://sub.example.com/page?x=1", undefined, "2026-07-27");
  assert.equal(path.dirname(p), process.cwd());
  assert.equal(path.basename(p), "seo-report-sub-example-com-2026-07-27.html");
  assert.ok(path.isAbsolute(p));
});

test("an implausible working directory falls back to the state reports dir", () => {
  // A GUI-launched MCP server often inherits "/" as its cwd; writing there means
  // the user never finds the report.
  for (const cwd of ["/", "/Applications", "/System/Library", os.homedir()]) {
    const p = resolveReportPath("https://example.com", undefined, "2026-07-27", { cwd });
    assert.equal(path.dirname(p), reportsDir(), `cwd ${cwd} should fall back`);
  }
});

test("a normal project directory is still used as-is", () => {
  const p = resolveReportPath("https://example.com", undefined, "2026-07-27", { cwd: "/Users/dev/my-project" });
  assert.equal(path.dirname(p), "/Users/dev/my-project");
});

test("output_path creates missing directories rather than failing", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "seo-mcp-mkdir-"));
  const nested = path.join(base, "reports", "2026", "q3");
  const res = finishReport("https://example.com", SAMPLE, { output: "html", output_path: nested });
  const out = res.content[0].text;
  assert.match(out, /HTML report written to/, `expected success, got: ${out}`);
  const file = out.split("\n")[0].replace("HTML report written to ", "");
  assert.ok(existsSync(file), "the report should exist in the created directory");
});

test("crawl targets get a distinct prefix and drop the crawl: scheme", () => {
  const p = resolveReportPath("crawl:https://example.com", undefined, "2026-07-27");
  assert.equal(path.basename(p), "seo-crawl-example-com-2026-07-27.html");
});

test("output_path accepts a directory or an explicit filename", () => {
  const dir = resolveReportPath("https://example.com", "/tmp/reports", "2026-07-27");
  assert.equal(dir, "/tmp/reports/seo-report-example-com-2026-07-27.html");
  const file = resolveReportPath("https://example.com", "/tmp/out.html", "2026-07-27");
  assert.equal(file, "/tmp/out.html");
});

/* ---------------- finishReport wiring ---------------- */

test("output: html writes a file and returns its path, not the markup", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seo-mcp-test-"));
  const res = finishReport("https://example.com", SAMPLE, { output: "html", output_path: dir });
  const out = res.content[0].text;
  assert.match(out, /HTML report written to/);
  assert.match(out, /1 failed, 1 warnings, 2 passed/);
  // The tool response must stay compact — the markup goes to disk, not context.
  assert.ok(out.length < 400, `summary should be short, got ${out.length} chars`);
  assert.doesNotMatch(out, /<!doctype/i);

  const file = out.split("\n")[0].replace("HTML report written to ", "");
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /Technical SEO audit/);
});

test("unwritable output_path returns an error line instead of throwing", () => {
  const res = finishReport("https://example.com", SAMPLE, {
    output: "html",
    output_path: "/nonexistent-root-dir-xyz/report.html",
  });
  assert.match(res.content[0].text, /❌ Could not write the HTML report/);
});

test("output: json still returns structured counts", () => {
  const res = finishReport("https://example.com", SAMPLE, { output: "json" });
  const parsed = JSON.parse(res.content[0].text);
  assert.deepEqual(parsed.counts, { pass: 2, warn: 1, fail: 1 });
  assert.equal(parsed.sections.length, 2);
});

/* ---------------- Baseline diffing ---------------- */

test("baseline round-trip: first run seeds, second run diffs fixes and regressions", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seo-mcp-baseline-"));
  const first = diffAgainstBaseline("https://example.com", parseReport(SAMPLE), { dir });
  assert.equal(first.hadBaseline, false);
  assert.equal(first.writeError, null, "baseline should write cleanly to a temp dir");

  // Title now passes (fixed); robots.txt now fails (regression).
  const improved = SAMPLE.replace("❌ No <title> tag found.", "✅ Title tag present.").replace(
    "✅ robots.txt found.",
    "❌ robots.txt missing."
  );
  const second = diffAgainstBaseline("https://example.com", parseReport(improved), { dir });
  assert.equal(second.hadBaseline, true);
  assert.equal(second.diff.fixed.length, 1);
  assert.match(second.diff.fixed[0], /title/i);
  assert.equal(second.diff.new_failures.length, 1);
  assert.match(second.diff.new_failures[0], /robots/i);
});

test("baselines are stored per target, so sites do not collide", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seo-mcp-baseline-"));
  diffAgainstBaseline("https://a.example.com", parseReport(SAMPLE), { dir });
  // A different target must read as a first run, not inherit a.example.com's checks.
  const other = diffAgainstBaseline("https://b.example.com", parseReport(SAMPLE), { dir });
  assert.equal(other.hadBaseline, false);
});

test("unwritable baseline dir surfaces a warning but does not throw", () => {
  const dir = "/nonexistent-root-dir-xyz/baselines";
  const res = diffAgainstBaseline("https://example.com", parseReport(SAMPLE), { dir });
  assert.ok(res.writeError, "should record a write error");
  assert.match(diffToMarkdown(res), /Baseline could not be saved/);
});

/* ---------------- Overwrite protection ---------------- */

test("an existing file that is not an seo-mcp report is never overwritten", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seo-mcp-overwrite-"));
  const file = path.join(dir, "index.html");
  const original = "<!doctype html><title>My real homepage</title>";
  writeFileSync(file, original);
  const result = finishReport("https://example.com", SAMPLE, { output: "html", output_path: file });
  assert.match(result.content[0].text, /not an seo-mcp report/);
  assert.equal(readFileSync(file, "utf8"), original, "the user's file must be untouched");
});

test("a previous seo-mcp report at the same path is replaced", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seo-mcp-overwrite-"));
  const file = path.join(dir, "report.html");
  finishReport("https://example.com", SAMPLE, { output: "html", output_path: file });
  const result = finishReport("https://example.org", SAMPLE, { output: "html", output_path: file });
  assert.match(result.content[0].text, /HTML report written to/);
  assert.match(readFileSync(file, "utf8"), /example\.org/);
});
