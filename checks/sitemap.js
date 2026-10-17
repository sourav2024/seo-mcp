import {
  parseUrlOrThrow,
  fetchPage,
  getResource,
  newResourceCache,
  fetchWithChain,
  delay,
  pass,
  warn,
  fail,
} from "./helpers.js";
import { config } from "../src/config.js";

/* ---------------- Sitemap ---------------- */

/**
 * Well-known locations tried only when robots.txt declares no sitemap and
 * /sitemap.xml is missing: Astro and Gatsby write sitemap-index.xml, Yoast and
 * Rank Math sitemap_index.xml, and WordPress core wp-sitemap.xml.
 */
const FALLBACK_SITEMAP_PATHS = ["/sitemap-index.xml", "/sitemap_index.xml", "/wp-sitemap.xml"];

/** True when a body is an XML sitemap rather than, say, an SPA's catch-all HTML page. */
const looksLikeSitemap = (body) => /<(urlset|sitemapindex)[\s>]/i.test(body);

/**
 * Sitemap URLs declared in a robots.txt body. `Sitemap:` lines are independent
 * of user-agent groups and may appear anywhere; relative values are resolved
 * against the origin to be forgiving, though the spec asks for absolute URLs.
 */
export function parseRobotsSitemaps(robotsBody, origin) {
  const urls = [];
  for (const m of (robotsBody || "").matchAll(/^[ \t]*sitemap[ \t]*:[ \t]*(\S+)/gim)) {
    try {
      const u = new URL(m[1], origin);
      if (u.protocol === "http:" || u.protocol === "https:") urls.push(u.href);
    } catch {
      /* malformed line — ignore, as crawlers do */
    }
  }
  return [...new Set(urls)];
}

/**
 * Find a site's sitemap the way search engines do: the `Sitemap:` lines in
 * robots.txt first, then /sitemap.xml, then the well-known index names.
 *
 * Checking only /sitemap.xml reported "missing" for every Astro, Gatsby, and
 * WordPress site whose sitemap lives at an index URL declared in robots.txt —
 * a false failure on a correctly configured site.
 *
 * @returns {Promise<{ url: string|null, source: "robots"|"default"|"fallback"|null,
 *   declared: string[], resource: object|null }>} `resource` is the fetched sitemap
 *   (or, when nothing was found, the /sitemap.xml response to report on).
 */
export async function discoverSitemap(origin, cache) {
  const robots = await getResource(`${origin}/robots.txt`, cache);
  const declared = robots.ok ? parseRobotsSitemaps(robots.body, origin) : [];

  if (declared.length) {
    for (const url of declared) {
      const resource = await getResource(url, cache);
      if (resource.ok && !resource.error) return { url, source: "robots", declared, resource };
    }
    // None of the declared sitemaps work: report the first, since that's the bug to fix.
    return { url: declared[0], source: "robots", declared, resource: await getResource(declared[0], cache) };
  }

  const defaultUrl = `${origin}/sitemap.xml`;
  const fallbackDefault = await getResource(defaultUrl, cache);
  if (fallbackDefault.ok && !fallbackDefault.error && looksLikeSitemap(fallbackDefault.body))
    return { url: defaultUrl, source: "default", declared, resource: fallbackDefault };

  for (const p of FALLBACK_SITEMAP_PATHS) {
    const url = `${origin}${p}`;
    const resource = await getResource(url, cache);
    if (resource.ok && !resource.error && looksLikeSitemap(resource.body))
      return { url, source: "fallback", declared, resource };
  }
  return { url: null, source: null, declared, resource: fallbackDefault };
}

/**
 * @param {string} url     any URL on the site — its sitemap is discovered via robots.txt
 * @param {Map}    [cache] per-audit resource cache, shared with the other checks
 */
export async function auditSitemap(url, cache) {
  const lines = ["## Sitemap"];
  const origin = parseUrlOrThrow(url, { context: "Sitemap site URL" }).origin;
  let smUrl = `${origin}/sitemap.xml`;
  try {
    const found = await discoverSitemap(origin, cache);
    const sitemap = found.resource;
    if (!found.url) {
      if (sitemap.error) throw sitemap.error;
      // /sitemap.xml answered 200 but isn't a sitemap (typically an SPA catch-all page).
      const what = sitemap.ok ? "returned a page that is not an XML sitemap" : `returned HTTP ${sitemap.status}`;
      lines.push(
        fail(
          `No sitemap found: robots.txt declares none, ${smUrl} ${what}, and ${FALLBACK_SITEMAP_PATHS.join(", ")} don't exist. ` +
            `Generate one (Yoast/next-sitemap/framework-native, or xml-sitemaps.com), keep it auto-updated, and add a "Sitemap:" line to robots.txt.`
        )
      );
      return lines.join("\n");
    }
    smUrl = found.url;
    if (sitemap.error) throw sitemap.error;
    const { ok: isOk, status } = sitemap;
    if (!isOk) {
      lines.push(
        fail(
          `robots.txt declares ${smUrl}, but it returned HTTP ${status}. Fix the sitemap or the "Sitemap:" line — crawlers follow the declaration.`
        )
      );
      return lines.join("\n");
    }
    if (found.source === "robots")
      lines.push(
        pass(
          `Sitemap declared in robots.txt${found.declared.length > 1 ? ` (${found.declared.length} declared; checking the first that responds)` : ""}.`
        )
      );
    else if (found.source === "fallback")
      lines.push(
        warn(
          `Found ${smUrl}, but it isn't declared in robots.txt and ${origin}/sitemap.xml doesn't exist. Add "Sitemap: ${smUrl}" to robots.txt so every crawler can find it.`
        )
      );

    let body = sitemap.body;
    const isIndex = /<sitemapindex/i.test(body);
    const locs = body.match(/<loc>/gi)?.length || 0;
    if (locs === 0 && !isIndex) {
      lines.push(
        warn(`${smUrl} exists but contains 0 <loc> entries — it isn't telling search engines about any pages.`)
      );
    } else {
      lines.push(pass(`${smUrl} exists (${isIndex ? "sitemap index" : "urlset"}, ${locs} <loc> entries).`));
    }
    const badPaths = body.match(/<loc>[^<]*(\/admin\/|\/cart|\/checkout|\?s=|\/search\?)[^<]*<\/loc>/gi);
    if (badPaths?.length)
      lines.push(
        warn(
          `${badPaths.length} entries look like admin/cart/checkout/search pages — include only valuable, canonical URLs.`
        )
      );
    else lines.push(pass("No admin/cart/checkout/search entries detected."));

    // A sitemap index lists child sitemaps, not pages: sample the first child so
    // index-based sites (Astro, Gatsby, Yoast) get their URLs checked too.
    if (isIndex) {
      const child = body.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
      if (child) {
        try {
          const { res, body: childBody } = await fetchPage(child);
          if (res.ok) {
            body = childBody;
            lines.push(`Sampling URLs from the first child sitemap: ${child}`);
          } else
            lines.push(fail(`Child sitemap ${child} returned HTTP ${res.status} — every listed sitemap must load.`));
        } catch (e) {
          lines.push(fail(`Child sitemap ${child} could not be fetched (${e.message}).`));
        }
      }
    }

    // Sample up to 10 <loc> URLs — sitemaps must list final, canonical, 200 URLs.
    const childLoaded = isIndex && !/<sitemapindex/i.test(body);
    const locUrls = isIndex && !childLoaded ? [] : [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
    const sample = locUrls.slice(0, 10);
    if (sample.length) {
      let ok = 0;
      const problems = [];
      for (const [i, loc] of sample.entries()) {
        if (i > 0) await delay(config.crawlDelayMs);
        try {
          const r = await fetchWithChain(loc, 3);
          if (r.chain.length > 0)
            problems.push(
              fail(
                `${loc} redirects (${r.chain.map((h) => h.status).join(" → ")}) to ${r.finalUrl} — list the final URL directly.`
              )
            );
          else if (r.status !== 200)
            problems.push(
              fail(`${loc} returns HTTP ${r.status} — remove it or fix the page; sitemaps must list live 200 URLs.`)
            );
          else ok++;
        } catch (e) {
          problems.push(fail(`${loc} could not be fetched (${e.message}).`));
        }
      }
      lines.push(
        problems.length
          ? `Sampled ${sample.length}/${locUrls.length} URLs — ${ok} OK:`
          : pass(`Sampled ${sample.length}/${locUrls.length} URLs — all return 200 with no redirects.`)
      );
      lines.push(...problems);

      // lastmod freshness
      const lastmods = [...body.matchAll(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/gi)]
        .map((m) => new Date(m[1]))
        .filter((d) => !isNaN(d));
      if (lastmods.length === 0) {
        lines.push(warn("No lastmod values — add them so crawlers prioritize recently-changed pages."));
      } else {
        const newest = new Date(Math.max(...lastmods.map((d) => d.getTime())));
        const staleMs = 1000 * 60 * 60 * 24 * 548; // ~18 months
        if (Date.now() - newest.getTime() > staleMs)
          lines.push(
            warn(
              `All lastmod values are stale — newest is ${newest.toISOString().slice(0, 10)}. Update them (or let your CMS auto-update the sitemap).`
            )
          );
        else
          lines.push(
            pass(`lastmod present on ${lastmods.length} entries (newest: ${newest.toISOString().slice(0, 10)}).`)
          );
      }
    }
  } catch (e) {
    lines.push(fail(`Could not fetch ${smUrl}: ${e.message}`));
  }
  return lines.join("\n");
}

/**
 * Collect same-origin URLs from the site's sitemaps (as declared in robots.txt,
 * else discovered — see discoverSitemap), following index files one level deep.
 */
export async function collectSitemapUrls(origin, cap = 500) {
  const urls = [];
  const seen = new Set();
  // Shared with discovery, so the sitemap it found isn't fetched a second time.
  const cache = newResourceCache();
  async function read(smUrl, depth) {
    if (depth > 1 || seen.has(smUrl) || seen.size > 10) return;
    seen.add(smUrl);
    try {
      const { ok, error, body } = await getResource(smUrl, cache);
      if (!ok || error) return;
      const locs = [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
      if (/<sitemapindex/i.test(body)) {
        for (const child of locs.slice(0, 10)) {
          await delay(config.crawlDelayMs);
          await read(child, depth + 1);
        }
      } else {
        urls.push(...locs);
      }
    } catch {
      /* unreadable sitemap — treated as absent */
    }
  }
  const { url, declared } = await discoverSitemap(origin, cache);
  for (const start of declared.length ? declared : url ? [url] : []) await read(start, 0);
  return [...new Set(urls)]
    .filter((u) => {
      try {
        return new URL(u).origin === origin;
      } catch {
        return false;
      }
    })
    .slice(0, cap);
}
