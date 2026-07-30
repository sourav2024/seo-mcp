import { getPage, pass, warn, fail } from "./helpers.js";

/* ---------------- Structured data (JSON-LD) ---------------- */
/** Guards against pathological JSON-LD: deep @graph nesting or huge node counts. */
const MAX_JSONLD_DEPTH = 32;
const MAX_JSONLD_NODES = 5_000;

/**
 * Flatten nested JSON-LD (arrays and @graph) into a flat node list.
 *
 * Depth- and count-capped, and cycle-aware: page content is untrusted, and a
 * self-referential @graph would otherwise recurse until the stack overflows.
 */
function flattenJsonLd(node, out = [], depth = 0, seen = new WeakSet()) {
  if (depth > MAX_JSONLD_DEPTH || out.length >= MAX_JSONLD_NODES) return out;
  if (Array.isArray(node)) {
    for (const n of node) flattenJsonLd(n, out, depth + 1, seen);
    return out;
  }
  if (node && typeof node === "object") {
    if (seen.has(node)) return out; // cycle — already visited this object
    seen.add(node);
    out.push(node);
    if (node["@graph"]) flattenJsonLd(node["@graph"], out, depth + 1, seen);
  }
  return out;
}

const MINIMAL_ORG_JSONLD = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Your Company",
  "url": "https://example.com",
  "logo": "https://example.com/logo.png",
  "sameAs": [
    "https://www.linkedin.com/company/yourcompany",
    "https://www.crunchbase.com/organization/yourcompany",
    "https://www.g2.com/products/yourproduct",
    "https://www.capterra.com/p/000000/yourproduct/"
  ]
}
</script>`;

export async function auditStructuredData(url, page) {
  const lines = ["## Structured data (JSON-LD)"];
  const { body } = await getPage(url, page);
  const blocks = [...body.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1].trim()
  );

  if (blocks.length === 0) {
    lines.push(
      fail(
        `No JSON-LD structured data found. Search engines and AI assistants use it to understand who you are. Add at least an Organization block:\n\n${MINIMAL_ORG_JSONLD}`
      )
    );
    return lines.join("\n");
  }

  const nodes = [];
  blocks.forEach((raw, i) => {
    try {
      flattenJsonLd(JSON.parse(raw), nodes);
    } catch (e) {
      lines.push(
        fail(
          `JSON-LD block ${i + 1} of ${blocks.length} is malformed — ${e.message}. Fix the syntax or the whole block is ignored.`
        )
      );
    }
  });

  const typesOf = (n) => [n["@type"]].flat().filter(Boolean);
  const allTypes = [...new Set(nodes.flatMap(typesOf))];
  if (allTypes.length)
    lines.push(
      pass(
        `Schema types present: ${allTypes.join(", ")} (${blocks.length} JSON-LD block${blocks.length > 1 ? "s" : ""}).`
      )
    );
  else if (nodes.length)
    lines.push(warn("JSON-LD parses but no @type values found — add @type so the data is usable."));
  const byType = (t) => nodes.filter((n) => typesOf(n).includes(t));

  // Organization
  const orgs = byType("Organization");
  if (orgs.length) {
    const withSameAs = orgs.filter((o) => Array.isArray(o.sameAs) && o.sameAs.length);
    lines.push(
      withSameAs.length
        ? pass(`Organization present with ${withSameAs[0].sameAs.length} sameAs links.`)
        : warn(
            "Organization present but sameAs is missing or empty — add profile URLs (LinkedIn, Crunchbase, G2, Capterra) so engines connect your entity across the web."
          )
    );
  } else {
    lines.push(warn(`No Organization schema — add one (typically site-wide in the layout):\n\n${MINIMAL_ORG_JSONLD}`));
  }

  // SoftwareApplication (product pages)
  const apps = byType("SoftwareApplication");
  if (apps.length) {
    const missing = ["name", "description", "applicationCategory", "offers"].filter((f) => !apps.some((a) => a[f]));
    lines.push(
      missing.length
        ? warn(`SoftwareApplication present but missing: ${missing.join(", ")}.`)
        : pass("SoftwareApplication present with name, description, applicationCategory, and offers.")
    );
  } else {
    lines.push(
      "Note: no SoftwareApplication schema — add one on product pages (name, description, applicationCategory, offers)."
    );
  }

  // FAQPage
  const faqs = byType("FAQPage");
  if (faqs.length) {
    const questions = faqs.flatMap((f) => [f.mainEntity].flat().filter(Boolean));
    const valid = questions.filter(
      (q) =>
        typesOf(q).includes("Question") && q.name && q.acceptedAnswer && [q.acceptedAnswer].flat().some((a) => a?.text)
    );
    lines.push(
      questions.length === 0
        ? fail("FAQPage present but has no mainEntity questions.")
        : valid.length === questions.length
          ? pass(`FAQPage valid: ${valid.length} Question/acceptedAnswer pairs.`)
          : fail(
              `FAQPage: only ${valid.length}/${questions.length} entries are valid Question objects with acceptedAnswer.text — invalid ones are ignored by Google.`
            )
    );
  }

  // BreadcrumbList
  if (byType("BreadcrumbList").length) lines.push(pass("BreadcrumbList present."));
  else lines.push("Note: no BreadcrumbList — worth adding on nested pages so results show your site hierarchy.");

  return lines.join("\n");
}
