import { getPage, pass, warn, fail, fetchWithChain, delay } from "./helpers.js";
import { config } from "../src/config.js";

/* ---------------- International SEO (hreflang) ---------------- */

/**
 * Region-agnostic language subtags that are valid on their own ("en", "fr") plus
 * the reserved x-default. Anything else must look like BCP-47: a 2-3 letter
 * language, optionally a 4-letter script, optionally a 2-letter or 3-digit region.
 *
 * We validate shape, not membership: maintaining the full IANA registry is not
 * worth two runtime dependencies, and a shape check catches the mistakes people
 * actually make — "en_US" (underscore) and "en-UK" (not a country code). A
 * three-letter language subtag is allowed through: "eng" is a real ISO 639-2
 * code, and telling someone their valid tag is broken is worse than staying
 * quiet about a redundant one.
 *
 * Tested against a case-NORMALISED value, because hreflang is case-insensitive
 * (Google: "the value is not case-sensitive"). Real sites ship `de-de` and
 * `en-us` — GitLab's entirely correct cluster is all-lowercase — so matching the
 * canonical casing literally would fail six valid annotations on a correct site.
 */
const BCP47 = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/**
 * Rewrite a value into BCP-47's canonical casing (`en-us` -> `en-US`,
 * `ZH-HANT-TW` -> `zh-Hant-TW`) so the shape test judges structure, not style.
 * Values that do not have 1-3 subtags are returned unchanged, to be rejected by
 * the shape test on their own merits.
 */
function canonicalCase(value) {
  const parts = value.split("-");
  if (parts.length < 1 || parts.length > 3) return value;
  return parts
    .map((part, i) => {
      if (i === 0) return part.toLowerCase();
      // A 4-letter subtag is a script (Titlecase); 2-letter/3-digit is a region.
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
      return part.toUpperCase();
    })
    .join("-");
}

/** Country codes that are NOT valid ISO 3166-1 alpha-2 but get used anyway. */
const FAKE_REGIONS = { UK: "GB", EU: null, ASIA: null, LATAM: null, GLOBAL: null };

/**
 * Extract every hreflang annotation from a page's <head>. Returns
 * {lang, href, raw}[] — attribute order varies in the wild, so each attribute is
 * matched independently rather than assuming href follows hreflang.
 */
export function parseHreflangTags(body) {
  const out = [];
  const linkTags = body.match(/<link\b[^>]*\bhreflang\b[^>]*>/gi) || [];
  for (const raw of linkTags) {
    // Only rel="alternate" carries hreflang meaning; rel="canonical" with an
    // hreflang attribute is a common copy-paste error and is not an annotation.
    const rel = raw.match(/\brel=["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    if (rel && rel !== "alternate") continue;
    const lang = raw.match(/\bhreflang=["']?([^"'\s>]+)/i)?.[1];
    const href = raw.match(/\bhref=["']?([^"'\s>]+)/i)?.[1];
    if (lang) out.push({ lang, href, raw });
  }
  return out;
}

/** Normalize for comparison: hreflang values are case-insensitive per spec. */
const key = (s) => s?.trim().toLowerCase();

/**
 * Validate one hreflang value's shape and flag the well-known wrong-but-common
 * forms. Returns null when the value is fine.
 */
export function hreflangValueProblem(lang) {
  const v = lang.trim();
  if (key(v) === "x-default") return null;
  if (v.includes("_")) return `"${v}" uses an underscore — hreflang uses a hyphen ("${v.replace(/_/g, "-")}").`;
  const region = v.split("-")[1]?.toUpperCase();
  if (region && region in FAKE_REGIONS) {
    const fix = FAKE_REGIONS[region];
    return fix
      ? `"${v}" — "${region}" is not an ISO 3166-1 country code; use "${v.split("-")[0]}-${fix}".`
      : `"${v}" — "${region}" is not a country code. hreflang regions must be ISO 3166-1 alpha-2 (target countries individually, or use x-default).`;
  }
  if (!BCP47.test(canonicalCase(v)))
    return `"${v}" is not a valid language[-script][-region] value (expected e.g. "en", "en-US", "fr-CA", "zh-Hant-TW").`;
  return null;
}

/**
 * Audit a page's hreflang cluster.
 *
 * Beyond presence, this verifies the three things that actually break
 * international setups and that a single-page look cannot catch:
 *   1. self-reference — the page must list itself
 *   2. return links — every page it points at must point back (Google ignores
 *      the whole cluster otherwise)
 *   3. x-default — needed so unmatched audiences get a defined destination
 *
 * verify_return_links fetches each alternate (capped), so it is opt-in.
 */
export async function auditHreflang(url, page, { verifyReturnLinks = false, maxAlternates = 10 } = {}) {
  const lines = ["## International SEO (hreflang)"];
  const { body } = await getPage(url, page);

  const htmlLang = body.match(/<html[^>]*\blang=["']?([^"'\s>]+)/i)?.[1];
  const tags = parseHreflangTags(body);

  if (tags.length === 0) {
    lines.push(
      warn(
        "No hreflang annotations found. If this site serves one language/country, that is correct — hreflang is only needed when the same content exists for multiple languages or regions. " +
          'If you target more than one country (e.g. US and Canada), add reciprocal <link rel="alternate" hreflang> tags plus an x-default so Google shows each audience the right URL instead of picking one itself.'
      )
    );
    lines.push(
      htmlLang
        ? pass(`<html lang="${htmlLang}"> declares the page language.`)
        : warn('No <html lang> attribute — declare the page language, e.g. <html lang="en">.')
    );
    return lines.join("\n");
  }

  lines.push(pass(`${tags.length} hreflang annotation${tags.length === 1 ? "" : "s"} found.`));

  // --- value validity ---
  const badValues = tags.map((t) => hreflangValueProblem(t.lang)).filter(Boolean);
  if (badValues.length) for (const b of badValues) lines.push(fail(`Invalid hreflang value: ${b}`));
  else lines.push(pass("All hreflang values are well-formed."));

  // --- missing href ---
  const noHref = tags.filter((t) => !t.href);
  if (noHref.length)
    lines.push(fail(`${noHref.length} hreflang tag(s) have no href — each annotation needs an absolute URL.`));

  // --- relative hrefs (spec wants absolute) ---
  const relative = tags.filter((t) => t.href && !/^https?:\/\//i.test(t.href));
  if (relative.length)
    lines.push(
      warn(
        `${relative.length} hreflang href(s) are relative (e.g. "${relative[0].href}") — use fully-qualified absolute URLs including the protocol and host.`
      )
    );

  // --- duplicates ---
  const seen = new Map();
  const dupes = new Set();
  for (const t of tags) {
    const k = key(t.lang);
    if (seen.has(k) && seen.get(k) !== t.href) dupes.add(t.lang);
    seen.set(k, t.href);
  }
  if (dupes.size)
    lines.push(
      fail(
        `Conflicting duplicate hreflang value(s): ${[...dupes].join(", ")} — each value may appear once per page, pointing at one URL.`
      )
    );

  // --- self-reference ---
  const current = url.replace(/#.*$/, "");
  const selfListed = tags.some((t) => {
    if (!t.href) return false;
    try {
      return new URL(t.href, url).href.replace(/\/$/, "") === current.replace(/\/$/, "");
    } catch {
      return false;
    }
  });
  lines.push(
    selfListed
      ? pass("Page includes a self-referencing hreflang annotation.")
      : fail(
          "No self-referencing hreflang — a page must list itself among its alternates, or Google may ignore the whole cluster."
        )
  );

  // --- x-default ---
  const hasXDefault = tags.some((t) => key(t.lang) === "x-default");
  lines.push(
    hasXDefault
      ? pass("x-default is present for unmatched audiences.")
      : warn(
          'No x-default annotation — add <link rel="alternate" hreflang="x-default" href="…"> so visitors outside your targeted regions get a defined page rather than a guess.'
        )
  );

  // --- html lang agreement ---
  if (htmlLang) {
    const selfTag = tags.find((t) => {
      try {
        return t.href && new URL(t.href, url).href.replace(/\/$/, "") === current.replace(/\/$/, "");
      } catch {
        return false;
      }
    });
    const declared = key(selfTag?.lang);
    // Compare the LANGUAGE subtag only: <html lang="en"> alongside
    // hreflang="en-US" is correct and idiomatic — lang declares the document's
    // language, hreflang adds the regional target. Only a genuine language
    // mismatch (lang="fr" vs hreflang="en-US") is worth reporting.
    const langOf = (v) => key(v)?.split("-")[0];
    if (declared && declared !== "x-default" && langOf(htmlLang) !== langOf(declared))
      lines.push(
        warn(
          `<html lang="${htmlLang}"> declares a different language than this page's own hreflang value ("${selfTag.lang}") — make them agree so the declared language is unambiguous.`
        )
      );
    else lines.push(pass(`<html lang="${htmlLang}"> agrees with the hreflang annotation.`));
  } else {
    lines.push(warn('No <html lang> attribute — declare the page language, e.g. <html lang="en">.'));
  }

  // --- return links (opt-in: one request per alternate) ---
  if (!verifyReturnLinks) {
    lines.push(
      pass(
        "Return-link verification skipped — set verify_return_links: true to fetch each alternate and confirm it points back (the most common reason a correct-looking cluster is ignored)."
      )
    );
    return lines.join("\n");
  }

  const alternates = tags
    .filter((t) => t.href)
    .map((t) => {
      try {
        return { lang: t.lang, href: new URL(t.href, url).href };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((t) => t.href.replace(/\/$/, "") !== current.replace(/\/$/, ""));

  if (alternates.length === 0) {
    lines.push(warn("No alternate URLs to verify — the only annotation points at this page."));
    return lines.join("\n");
  }

  const sample = alternates.slice(0, maxAlternates);
  if (alternates.length > sample.length)
    lines.push(warn(`Checking return links for the first ${sample.length} of ${alternates.length} alternates.`));

  const missing = [];
  const unreachable = [];
  for (const [i, alt] of sample.entries()) {
    if (i > 0) await delay(config.crawlDelayMs);
    try {
      const r = await fetchWithChain(alt.href, 3);
      if (r.status < 200 || r.status >= 300) {
        unreachable.push(`${alt.lang} → ${alt.href} (HTTP ${r.status || "error"})`);
        continue;
      }
      const back = parseHreflangTags(r.body).some((t) => {
        if (!t.href) return false;
        try {
          return new URL(t.href, r.finalUrl).href.replace(/\/$/, "") === current.replace(/\/$/, "");
        } catch {
          return false;
        }
      });
      if (!back) missing.push(`${alt.lang} → ${alt.href}`);
    } catch {
      unreachable.push(`${alt.lang} → ${alt.href} (fetch failed)`);
    }
  }

  if (unreachable.length)
    lines.push(fail(`${unreachable.length} alternate(s) could not be fetched: ${unreachable.join("; ")}.`));
  if (missing.length)
    lines.push(
      fail(
        `${missing.length} alternate(s) do not link back to this page: ${missing.join("; ")}. ` +
          "hreflang must be reciprocal — Google discards annotations without a return link."
      )
    );
  else if (!unreachable.length)
    lines.push(pass(`All ${sample.length} checked alternate(s) link back — the cluster is reciprocal.`));

  return lines.join("\n");
}
