import { parseUrlOrThrow, fetchPage, getResource, fetchWithChain, delay, pass, warn, fail } from "./helpers.js";
import { config } from "../src/config.js";

/* ---------------- Sitemap ---------------- */

/**
 * @param {string} url     any URL on the site — the origin's /sitemap.xml is checked
 * @param {Map}    [cache] per-audit resource cache, shared with the other checks
 */
export async function auditSitemap(url, cache) {
  const lines = ["## Sitemap"];
  const origin = parseUrlOrThrow(url, { context: "Sitemap site URL" }).origin;
  const smUrl = `${origin}/sitemap.xml`;
  try {
    const sitemap = await getResource(smUrl, cache);
    if (sitemap.error) throw sitemap.error;
    const { ok: isOk, status, body } = sitemap;
    if (!isOk) {
      lines.push(
        fail(
          `${smUrl} returned HTTP ${status}. Generate one (Yoast/next-sitemap/framework-native, or xml-sitemaps.com) and keep it auto-updated.`
        )
      );
      return lines.join("\n");
    }
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

    // Sample up to 10 <loc> URLs — sitemaps must list final, canonical, 200 URLs.
    const locUrls = isIndex ? [] : [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
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

/** Collect same-origin URLs from /sitemap.xml, following sitemap index files one level deep. */
export async function collectSitemapUrls(origin, cap = 500) {
  const urls = [];
  const seen = new Set();
  async function read(smUrl, depth) {
    if (depth > 1 || seen.has(smUrl) || seen.size > 10) return;
    seen.add(smUrl);
    try {
      const { res, body } = await fetchPage(smUrl);
      if (!res.ok) return;
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
  await read(`${origin}/sitemap.xml`, 0);
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
