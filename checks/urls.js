import { normalizeUrl, pass, fail } from "./helpers.js";

/* ---------------- Clean URLs ---------------- */

/** Clean-URL thresholds (Google's guidance is directional, not absolute). */
const MAX_URL_LENGTH = 60;
const MAX_PATH_DEPTH = 4;
/** Query keys that signal a database-id URL rather than a readable path. */
const MESSY_PARAM = /(\bid=|\bp=|\bpage_id=)/i;

/**
 * Analyze URLs against clean-URL best practices.
 *
 * Each URL is evaluated independently: a malformed entry becomes its own ❌ line
 * rather than throwing, so one bad input in a batch can never discard the
 * findings for every other URL.
 */
export function auditUrlStructure(urls) {
  const lines = ["## Clean, short URLs"];
  for (const raw of urls) {
    let u;
    try {
      u = new URL(normalizeUrl(raw));
    } catch {
      lines.push(fail(`${raw} → not a parsable URL (check for typos, spaces, or missing host).`));
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      lines.push(fail(`${raw} → not a web URL (scheme "${u.protocol}"); only http:// and https:// apply.`));
      continue;
    }

    const issues = [];
    const full = u.href;
    if (full.length > MAX_URL_LENGTH) issues.push(`length ${full.length} chars (aim ≤ ~${MAX_URL_LENGTH})`);
    if (/[A-Z]/.test(u.pathname)) issues.push("contains uppercase letters");
    if (/_/.test(u.pathname)) issues.push("uses underscores (use hyphens instead)");
    if (/[^\x00-\x7F]/.test(full)) issues.push("contains accents/non-ASCII characters");
    if (u.search && MESSY_PARAM.test(u.search)) issues.push(`messy parameters (${u.search}) — prefer readable paths`);
    const depth = u.pathname.split("/").filter(Boolean).length;
    if (depth > MAX_PATH_DEPTH) issues.push(`deep nesting (${depth} levels) — reflect a simple hierarchy`);
    lines.push(issues.length ? fail(`${raw} → ${issues.join("; ")}`) : pass(`${raw} looks clean.`));
  }
  lines.push("Note: if you rename any URL, add a 301 redirect old → new to preserve equity and avoid 404s.");
  return lines.join("\n");
}
