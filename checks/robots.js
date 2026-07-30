import { parseUrlOrThrow, getResource, pass, warn, fail } from "./helpers.js";

/* ---------------- Robots.txt ---------------- */

/** Paste-ready starter file, reused across the failure paths below. */
const EXAMPLE_ROBOTS = (origin) => `User-agent: *\nDisallow: /admin/\nAllow: /\nSitemap: ${origin}/sitemap.xml`;

/**
 * @param {string} url  any URL on the site — the origin's /robots.txt is checked
 * @param {Map}   [cache]  per-audit resource cache, shared with auditAiCrawlers
 */
export async function auditRobots(url, cache) {
  const lines = ["## Robots.txt"];
  const origin = parseUrlOrThrow(url, { context: "Robots site URL" }).origin;
  const rUrl = `${origin}/robots.txt`;

  const { ok, status, body, finalUrl, error } = await getResource(rUrl, cache);
  if (error) {
    lines.push(fail(`Could not fetch ${rUrl}: ${error.message}`));
    return lines.join("\n");
  }
  if (!ok) {
    lines.push(fail(`${rUrl} returned HTTP ${status}. Add one, e.g.:\n\n${EXAMPLE_ROBOTS(origin)}`));
    return lines.join("\n");
  }
  if (!/^\s*user-agent\s*:/im.test(body)) {
    const landed = finalUrl && finalUrl !== rUrl ? ` (request redirected to ${finalUrl})` : "";
    lines.push(
      fail(
        `${rUrl} does not contain any User-agent groups${landed} — it is not a valid robots.txt. Serve a real one at this exact path, e.g.:\n\n${EXAMPLE_ROBOTS(origin)}`
      )
    );
    return lines.join("\n");
  }

  lines.push(pass(`${rUrl} exists.`));
  if (/sitemap:/i.test(body)) lines.push(pass("Sitemap referenced in robots.txt."));
  else lines.push(warn(`No Sitemap: line — add "Sitemap: ${origin}/sitemap.xml".`));
  if (/^\s*Disallow:\s*\/\s*$/im.test(body))
    lines.push(fail("Contains 'Disallow: /' — the ENTIRE site is blocked from crawling!"));
  lines.push(
    "Note: robots.txt only blocks crawling — it does NOT de-index already indexed pages (use noindex for that)."
  );
  return lines.join("\n");
}
