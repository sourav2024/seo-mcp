import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { text, severityOf, checkKey, pass, warn, fail } from "./helpers.js";
import { writeHtmlReport } from "./html-report.js";
import { baselineDir } from "../src/config.js";
import { log } from "../src/logger.js";

export { baselineDir };

/* ---------------- Output modes & baseline diffing ---------------- */

/**
 * One file per target, so unrelated sites/projects never share (or corrupt) a
 * single growing store. The hash guarantees uniqueness; the readable prefix
 * keeps the directory browsable.
 *
 * The slug is whitelist-filtered to [a-z0-9-], which makes path traversal
 * impossible even though `target` is user-supplied — no "/", "\" or ".." can
 * survive into the filename. The hash (not the slug) carries the identity, so
 * aggressive stripping is safe.
 */
export function baselineFileFor(target, dir = baselineDir()) {
  const hash = createHash("sha256").update(target).digest("hex").slice(0, 12);
  const slug = target
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();
  return path.join(dir, `${slug || "target"}-${hash}.json`);
}

/** Parse a full Markdown report into [{ section, checks: [{severity, text}] }]. */
export function parseReport(markdown) {
  const sections = [];
  let current = null;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      current = { section: line.slice(3).trim(), checks: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const sev = severityOf(line);
    if (sev === "note") {
      // continuation lines (multi-line fix snippets) attach to the previous check
      if (current.checks.length && line.trim()) current.checks.at(-1).text += `\n${line}`;
      continue;
    }
    current.checks.push({ severity: sev, text: line.replace(/^[✅⚠️❌]️?\s*/u, "") });
  }
  return sections;
}

export function countsOf(sections) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const s of sections)
    for (const c of s.checks) {
      // Ignore any severity outside the known set rather than creating a stray key.
      if (Object.hasOwn(counts, c.severity)) counts[c.severity]++;
    }
  return counts;
}

/**
 * Diff parsed results against the saved baseline for this target, then persist
 * the current results as the new baseline.
 *
 * Both maps use null-prototype objects: their keys come from page content, so a
 * check line containing "__proto__" or "constructor" would otherwise be able to
 * walk the prototype chain.
 */
export function diffAgainstBaseline(target, sections, { dir } = {}) {
  const file = baselineFileFor(target, dir);
  let store = Object.create(null);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      store = Object.assign(Object.create(null), parsed);
  } catch (err) {
    // Missing file is the normal first run; a corrupt file is worth surfacing.
    if (err.code !== "ENOENT") log.warn("Baseline unreadable — treating as first run", { file, err });
  }
  const prev = store[target]?.checks ? Object.assign(Object.create(null), store[target].checks) : null;
  const curr = Object.create(null);
  for (const s of sections)
    for (const c of s.checks)
      curr[checkKey(s.section, c.text)] = {
        severity: c.severity,
        text: c.text.split("\n")[0],
        section: s.section,
      };

  const diff = {
    baseline_at: store[target]?.generated_at ?? null,
    new_failures: [],
    new_warnings: [],
    fixed: [],
  };
  if (prev) {
    for (const [k, v] of Object.entries(curr)) {
      const old = prev[k];
      if (v.severity === "fail" && old?.severity !== "fail") diff.new_failures.push(`[${v.section}] ${v.text}`);
      else if (v.severity === "warn" && (!old || old.severity === "pass"))
        diff.new_warnings.push(`[${v.section}] ${v.text}`);
    }
    for (const [k, old] of Object.entries(prev)) {
      if ((old.severity === "fail" || old.severity === "warn") && (!curr[k] || curr[k].severity === "pass"))
        diff.fixed.push(`[${old.section}] ${old.text}`);
    }
  }

  store[target] = { generated_at: new Date().toISOString(), checks: curr };
  // A failed baseline write must never sink the audit itself — report it and move on.
  let writeError = null;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(store, null, 2));
    log.debug("Baseline saved", { file, checks: Object.keys(curr).length });
  } catch (err) {
    writeError = `${err.code || ""} ${err.message}`.trim();
    log.warn("Baseline could not be saved", { file, err });
  }
  return { diff, hadBaseline: prev !== null, writeError };
}

export function diffToMarkdown({ diff, hadBaseline, writeError }) {
  const lines = ["## Changes since last baseline"];
  if (writeError)
    lines.push(
      warn(
        `Baseline could not be saved (${writeError}) — this run was not recorded. Set SEO_MCP_STATE_DIR to a writable directory.`
      )
    );
  if (!hadBaseline) {
    lines.push("First run for this target — baseline saved; the next run will show a diff.");
    return lines.join("\n");
  }
  lines.push(`Compared against baseline from ${diff.baseline_at}.`);
  if (!diff.new_failures.length && !diff.new_warnings.length && !diff.fixed.length)
    lines.push(pass("No changes since the last run."));
  for (const f of diff.new_failures) lines.push(fail(`NEW FAILURE: ${f}`));
  for (const w of diff.new_warnings) lines.push(warn(`New warning: ${w}`));
  for (const x of diff.fixed) lines.push(pass(`Fixed: ${x}`));
  return lines.join("\n");
}

/** Shared finisher for seo_full_audit / crawl_audit: output mode + baseline. */
export function finishReport(
  target,
  markdown,
  { output = "markdown", compare_to_baseline = false, output_path = undefined, baseline_dir = undefined } = {}
) {
  const sections = parseReport(markdown);
  const baseline = compare_to_baseline ? diffAgainstBaseline(target, sections, { dir: baseline_dir }) : null;
  if (output === "html") {
    // Prepend the baseline diff as its own section so it appears in the file too.
    const all = baseline ? [...parseReport(diffToMarkdown(baseline)), ...sections] : sections;
    return text(writeHtmlReport(target, all, countsOf(all), output_path));
  }
  if (output === "json") {
    const data = {
      target,
      generated_at: new Date().toISOString(),
      counts: countsOf(sections),
      ...(baseline ? { baseline_diff: baseline.diff, first_run: !baseline.hadBaseline } : {}),
      sections,
    };
    // structuredContent lets a client consume the object directly; the text
    // block carries the same JSON for clients that don't support the field.
    return { ...text(JSON.stringify(data, null, 2)), structuredContent: data };
  }
  return text(baseline ? `${diffToMarkdown(baseline)}\n\n${markdown}` : markdown);
}
