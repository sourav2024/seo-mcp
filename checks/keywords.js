import { getPage, parseUrlOrThrow, stripTags, toStemmedWords, countPhrase, pass, warn, fail } from "./helpers.js";

/* ---------------- On-page keyword placement ---------------- */
export async function auditKeywordPlacement(url, keyword, page) {
  const kw = keyword.toLowerCase().trim();
  const lines = [`## Keyword placement — "${keyword}" on ${url}`];
  const { body } = await getPage(url, page);
  // Stem-tolerant: "freight broker" matches "freight brokers" and vice versa.
  const has = (s) => countPhrase(s, kw) > 0;

  // Title
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
  lines.push(
    has(title)
      ? pass(`Keyword in <title>: "${title}"`) +
          (title.toLowerCase().indexOf(kw) > 30
            ? `\n${warn("Keyword appears late in the title — front-load it when natural.")}`
            : "")
      : fail(`Keyword not in <title> ("${title}"). The title is the strongest on-page placement.`)
  );

  // URL
  const slugKw = kw.replace(/\s+/g, "-");
  const path = parseUrlOrThrow(url, { context: "Keyword page URL" }).pathname.toLowerCase();
  lines.push(
    path.includes(slugKw) || has(decodeURIComponent(path).replace(/[-_/]/g, " "))
      ? pass("Keyword present in the URL path.")
      : warn(`Keyword not in URL path (${path}) — include one primary keyword if it fits, no stuffing.`)
  );

  // Meta description
  const desc =
    body.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
    body.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ||
    "";
  lines.push(
    has(desc)
      ? pass("Keyword in meta description.")
      : warn(
          `Keyword not in meta description — it doesn't affect ranking directly but boosts click-through when bolded in results.`
        )
  );

  // H1 and H2s
  const h1 = stripTags(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  lines.push(has(h1) ? pass(`Keyword in <h1>: "${h1}"`) : fail(`Keyword not in <h1> ("${h1 || "none found"}").`));
  const h2s = [...body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => stripTags(m[1]));
  const h2Hits = h2s.filter((h) => has(h)).length;
  lines.push(
    h2s.length === 0
      ? warn("No <h2> subheadings found — structure content with keyword-bearing subheadings.")
      : h2Hits > 0
        ? pass(`Keyword (or variant) in ${h2Hits}/${h2s.length} <h2> subheadings.`)
        : warn(`Keyword in 0/${h2s.length} <h2> subheadings — work it (or close variants) into at least one.`)
  );

  // First paragraph / first 100 words
  const visible = stripTags(body.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || body);
  const first100 = visible.split(/\s+/).slice(0, 100).join(" ");
  lines.push(
    has(first100)
      ? pass("Keyword appears in the first ~100 words of visible content.")
      : warn("Keyword not in the first ~100 words — introduce it early in the opening paragraph.")
  );

  // Image alt text
  const imgs = body.match(/<img[^>]*>/gi) || [];
  const alts = imgs.map((i) => i.match(/alt=["']([^"']*)["']/i)?.[1] || "");
  const missingAlt = alts.filter((a) => !a.trim()).length;
  const altHits = alts.filter((a) => has(a)).length;
  if (imgs.length) {
    lines.push(
      altHits > 0
        ? pass(`Keyword in ${altHits}/${imgs.length} image alt attributes.`)
        : warn(`Keyword in 0/${imgs.length} image alt attributes — describe at least one relevant image with it.`)
    );
    if (missingAlt > 0)
      lines.push(warn(`${missingAlt}/${imgs.length} images have no alt text at all (accessibility + image SEO).`));
  }

  // Density (stem-tolerant, same 0.3% / 3% thresholds)
  const totalWords = toStemmedWords(visible).length;
  const kwLen = toStemmedWords(kw).length;
  const count = countPhrase(visible, kw);
  const density = totalWords ? ((count * kwLen) / totalWords) * 100 : 0;
  lines.push(
    count === 0
      ? fail("Keyword does not appear in the body content at all.")
      : density > 3
        ? fail(
            `Keyword density ${density.toFixed(1)}% (${count}×) — reads as stuffing; aim for ~0.5–2% used naturally.`
          )
        : density < 0.3
          ? warn(
              `Keyword density ${density.toFixed(2)}% (${count}× in ${totalWords} words) — thin; use it and close variants a bit more.`
            )
          : pass(
              `Keyword density ${density.toFixed(1)}% (${count}× in ${totalWords} words) — in the healthy ~0.5–2% range.`
            )
  );

  lines.push(
    "Reminder: place keywords where they read naturally — title, URL, H1, early paragraph, one subheading, one alt text. Never stuff."
  );
  return lines.join("\n");
}
