import { getPage, pass, fail } from "./helpers.js";

/* ---------------- Rendering / CMS output ---------------- */
export async function auditRendering(url, page) {
  const lines = ["## Rendering (server-rendered HTML vs client-side JS)"];
  const { body } = await getPage(url, page);
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const inner = (bodyMatch ? bodyMatch[1] : body)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (inner.length < 200) {
    lines.push(
      fail(
        `Page appears to be a client-side JS shell (only ${inner.length} chars of visible text without JS). ` +
          `Google/AI crawlers may struggle to interpret it. Prefer server-rendered HTML (SSR/SSG: Next.js, Astro, prerendering).`
      )
    );
  } else {
    lines.push(pass(`Server returns rendered HTML (${inner.length} chars of visible text without JS).`));
  }
  return lines.join("\n");
}
