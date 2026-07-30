/**
 * Standalone HTML report renderer.
 *
 * MCP tools return text to a model, so we never send the full HTML back through
 * the transport (it would burn context and the model can't render it). Instead
 * we write a self-contained file and return its path plus a compact summary.
 *
 * "Self-contained" is load-bearing: inlined CSS, no external fonts/scripts/images,
 * so the file works offline, over file://, and when emailed to a client.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION, HOMEPAGE } from "../src/version.js";
import { config } from "../src/config.js";

const SEV = {
  fail: { label: "Fail", icon: "✕", cls: "fail" },
  warn: { label: "Warning", icon: "!", cls: "warn" },
  pass: { label: "Pass", icon: "✓", cls: "pass" },
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render one check. The first line is the finding; any continuation lines are
 * fix snippets (often HTML/JSON-LD to paste), so they render as a code block.
 */
function renderCheck(check) {
  const sev = SEV[check.severity] ?? SEV.pass;
  const [first, ...rest] = check.text.split("\n");
  const detail = rest.join("\n").trim();
  return `<li class="check ${sev.cls}">
<span class="badge" aria-label="${sev.label}">${sev.icon}</span>
<div class="body"><p>${escapeHtml(first)}</p>${
    detail ? `<pre><code>${escapeHtml(detail)}</code></pre>` : ""
  }</div></li>`;
}

function renderSection(section) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of section.checks) counts[c.severity]++;
  // Sections needing action start open; all-clear sections start collapsed.
  const open = counts.fail || counts.warn ? " open" : "";
  const chips = ["fail", "warn", "pass"]
    .filter((k) => counts[k])
    .map((k) => `<span class="chip ${k}">${counts[k]} ${SEV[k].label.toLowerCase()}</span>`)
    .join("");
  return `<details class="section"${open}>
<summary><span class="sec-title">${escapeHtml(section.section)}</span><span class="chips">${chips}</span></summary>
<ul class="checks">${section.checks.map(renderCheck).join("")}</ul>
</details>`;
}

const STYLES = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1a1d21;--muted:#5c6570;--line:#e3e6ea;
--pass:#12805c;--warn:#9a6200;--fail:#c0362c;--pass-bg:#e8f5f0;--warn-bg:#fdf3e2;--fail-bg:#fdecea;}
@media (prefers-color-scheme:dark){:root{--bg:#15181c;--card:#1d2126;--ink:#e8eaed;--muted:#9aa4b0;
--line:#2c3238;--pass:#4ecfa4;--warn:#e0b050;--fail:#f08579;--pass-bg:#16302a;--warn-bg:#332a17;--fail-bg:#36211f;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.wrap{max-width:920px;margin:0 auto;padding:32px 20px 64px}
header h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
header .target{color:var(--muted);font-size:14px;word-break:break-all}
header .target a{color:inherit}
header time{display:block;color:var(--muted);font-size:13px;margin-top:6px}
.score{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 26px}
.score div{flex:1 1 120px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.score b{display:block;font-size:26px;line-height:1.1;font-variant-numeric:tabular-nums}
.score span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.score .p b{color:var(--pass)}.score .w b{color:var(--warn)}.score .f b{color:var(--fail)}
.section{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;overflow:hidden}
summary{cursor:pointer;padding:13px 16px;display:flex;align-items:center;gap:12px;
justify-content:space-between;font-weight:600;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";color:var(--muted);font-weight:400;flex:none}
.section[open]>summary::before{content:"▾"}
.sec-title{flex:1;min-width:0}
.chips{display:flex;gap:6px;flex:none}
.chip{font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;white-space:nowrap}
.chip.pass{background:var(--pass-bg);color:var(--pass)}
.chip.warn{background:var(--warn-bg);color:var(--warn)}
.chip.fail{background:var(--fail-bg);color:var(--fail)}
.checks{list-style:none;margin:0;padding:0 16px 8px;border-top:1px solid var(--line)}
.check{display:flex;gap:11px;padding:11px 0;border-bottom:1px solid var(--line)}
.check:last-child{border-bottom:0}
.badge{flex:none;width:19px;height:19px;border-radius:50%;font-size:11px;font-weight:700;
display:flex;align-items:center;justify-content:center;margin-top:2px}
.pass>.badge{background:var(--pass-bg);color:var(--pass)}
.warn>.badge{background:var(--warn-bg);color:var(--warn)}
.fail>.badge{background:var(--fail-bg);color:var(--fail)}
.body{min-width:0;flex:1}
.body p{margin:0}
pre{margin:9px 0 2px;padding:11px 13px;background:var(--bg);border:1px solid var(--line);
border-radius:7px;overflow-x:auto;font-size:12.5px;line-height:1.5}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
footer{margin-top:26px;color:var(--muted);font-size:12px;text-align:center}
footer a{color:inherit}
@media print{body{background:#fff}.section{break-inside:avoid}.section:not([open])>.checks{display:block}}
`;

/**
 * Build the full HTML document from parsed sections.
 * @param {string} target  audited URL (or "crawl:<url>")
 * @param {Array}  sections output of parseReport()
 * @param {object} counts   {pass, warn, fail}
 */
export function renderHtmlReport(target, sections, counts, generatedAt) {
  const isCrawl = target.startsWith("crawl:");
  const url = isCrawl ? target.slice(6) : target;
  const safeUrl = escapeHtml(url);
  const title = `SEO audit — ${url}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style></head>
<body><div class="wrap">
<header>
<h1>${isCrawl ? "Site crawl audit" : "Technical SEO audit"}</h1>
<div class="target"><a href="${safeUrl}" rel="noreferrer noopener">${safeUrl}</a></div>
<time datetime="${escapeHtml(generatedAt)}">Generated ${escapeHtml(generatedAt)}</time>
</header>
<div class="score">
<div class="f"><b>${counts.fail}</b><span>Failed</span></div>
<div class="w"><b>${counts.warn}</b><span>Warnings</span></div>
<div class="p"><b>${counts.pass}</b><span>Passed</span></div>
</div>
${sections.map(renderSection).join("\n")}
<footer>Generated by <a href="${HOMEPAGE}" rel="noreferrer noopener">seo-mcp</a> v${VERSION} — sections with findings are expanded by default.</footer>
</div></body></html>`;
}

/** Where reports go when the working directory isn't a usable location. */
export const reportsDir = () => path.join(config.stateDir, "reports");

/**
 * Roots and system directories are the tell-tale signs of a GUI-launched
 * process: no user runs a project from "/" or "/Applications".
 */
function isPlausibleWorkingDir(cwd) {
  if (!cwd) return false;
  const normalized = path.resolve(cwd);
  if (normalized === path.parse(normalized).root) return false;
  if (/^\/(Applications|System|Library|usr|bin|sbin|private\/var)(\/|$)/.test(normalized)) return false;
  if (normalized === os.homedir()) return false; // dumping reports in $HOME is unhelpful
  return true;
}

/** Filesystem-safe slug for the default filename, e.g. "example-com". */
function slugifyTarget(target) {
  const raw = target.startsWith("crawl:") ? target.slice(6) : target;
  let host = raw;
  try {
    host = new URL(raw).host;
  } catch {
    /* not a parsable URL — fall through to raw */
  }
  const slug = host
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return slug || "report";
}

/**
 * Resolve where the report should be written.
 *
 * `output_path` wins. Otherwise the default is the current directory *only* when
 * that looks like a real project directory: an MCP server launched from a GUI
 * client inherits an arbitrary cwd (often "/" on macOS), and writing a report
 * there means the user never finds it. In that case we fall back to a reports
 * directory under the state dir, whose location is documented and stable.
 */
export function resolveReportPath(target, outputPath, dateStr, { cwd = process.cwd() } = {}) {
  const prefix = target.startsWith("crawl:") ? "seo-crawl" : "seo-report";
  const defaultName = `${prefix}-${slugifyTarget(target)}-${dateStr}.html`;
  if (!outputPath) {
    return path.join(isPlausibleWorkingDir(cwd) ? cwd : reportsDir(), defaultName);
  }
  const expanded = outputPath.startsWith("~") ? path.join(process.env.HOME || "", outputPath.slice(1)) : outputPath;
  const abs = path.resolve(expanded);
  return /\.html?$/i.test(abs) ? abs : path.join(abs, defaultName);
}

/** Write the report and return a short text summary for the model. */
export function writeHtmlReport(target, sections, counts, outputPath) {
  const now = new Date();
  const generatedAt = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const file = resolveReportPath(target, outputPath, now.toISOString().slice(0, 10));
  const html = renderHtmlReport(target, sections, counts, generatedAt);
  try {
    // Create the destination if needed: output_path may name a directory that
    // does not exist yet, which is a reasonable thing for a caller to ask for.
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, html, "utf8");
  } catch (e) {
    return `❌ Could not write the HTML report to ${file}: ${e.code || e.message}. Pass output_path with a writable location, or use output: "markdown".`;
  }
  const total = counts.pass + counts.warn + counts.fail;
  return [
    `HTML report written to ${file}`,
    `${total} checks — ${counts.fail} failed, ${counts.warn} warnings, ${counts.pass} passed.`,
    "Open it in a browser to review; sections with findings are expanded by default.",
  ].join("\n");
}
