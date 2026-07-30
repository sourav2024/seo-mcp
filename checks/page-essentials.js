import { getPage, pass, warn, fail } from "./helpers.js";

/* ---------------- Page essentials (metadata, mobile, UX, images) ---------------- */
export async function auditPageEssentials(url, page) {
  const lines = ["## Page essentials (metadata, mobile-first, images)"];
  const { body } = await getPage(url, page);

  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  if (!title) lines.push(fail("Missing <title>."));
  else if (title.length > 65)
    lines.push(warn(`<title> is ${title.length} chars — keep ~60 or less: "${title.slice(0, 80)}…"`));
  else lines.push(pass(`<title> present (${title.length} chars): "${title}"`));

  const metaDesc = body.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0];
  const descContent = metaDesc?.match(/content=["']([^"']*)["']/i)?.[1];
  if (!descContent) lines.push(fail("Missing meta description."));
  else lines.push(pass(`Meta description present (${descContent.length} chars).`));

  const h1s = body.match(/<h1[\s>]/gi) || [];
  if (h1s.length === 0) lines.push(fail("No <h1> found."));
  else if (h1s.length > 1) lines.push(warn(`${h1s.length} <h1> tags — use exactly one.`));
  else lines.push(pass("Exactly one <h1>."));

  if (/<link[^>]+rel=["']canonical["']/i.test(body)) lines.push(pass("Canonical tag present."));
  else lines.push(warn("No canonical tag — add one to avoid duplicate-content issues."));

  if (/<meta[^>]+property=["']og:title["']/i.test(body)) lines.push(pass("Open Graph tags present."));
  else lines.push(warn("No Open Graph tags — links shared to social will render poorly."));

  // Mobile-first: viewport meta (Google indexes mobile first; ~60% of traffic is mobile)
  if (/<meta[^>]+name=["']viewport["'][^>]*width=device-width/i.test(body))
    lines.push(pass("Responsive viewport meta present (mobile-first ready)."));
  else lines.push(fail("Missing responsive viewport meta — weak mobile UX drags down rankings."));

  // Images: lazy loading + modern formats
  const imgs = body.match(/<img[^>]*>/gi) || [];
  if (imgs.length) {
    const lazy = imgs.filter((i) => /loading=["']lazy["']/i.test(i)).length;
    const modern = imgs.filter((i) => /\.(webp|avif)/i.test(i)).length;
    lines.push(
      lazy / imgs.length >= 0.5
        ? pass(`${lazy}/${imgs.length} images lazy-loaded.`)
        : warn(`Only ${lazy}/${imgs.length} images lazy-loaded — enable lazy loading.`)
    );
    lines.push(
      modern > 0
        ? pass(`${modern}/${imgs.length} images use WebP/AVIF.`)
        : warn(`No WebP/AVIF images detected — compress (TinyPNG/Squoosh) and serve WebP where safe.`)
    );
    // CLS risk: images without explicit dimensions cause layout shift as they load
    const noDims = imgs.filter((i) => !/\bwidth\s*=/i.test(i) || !/\bheight\s*=/i.test(i)).length;
    lines.push(
      noDims === 0
        ? pass(`All ${imgs.length} images declare explicit width/height.`)
        : warn(
            `${noDims}/${imgs.length} images missing explicit width/height attributes — the browser can't reserve space, causing layout shift (CLS) as they load.`
          )
    );
  } else {
    lines.push(pass("No <img> tags found in initial HTML."));
  }
  return lines.join("\n");
}
