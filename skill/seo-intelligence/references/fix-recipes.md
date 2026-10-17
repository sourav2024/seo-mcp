# Fix recipes: where each finding lives

Identify the stack first — `package.json` dependencies, config files
(`next.config.*`, `nuxt.config.*`, `astro.config.*`, `svelte.config.*`,
`gatsby-config.*`), `wp-config.php`, or hosting files (`vercel.json`,
`netlify.toml`, `_headers`, `_redirects`, `nginx.conf`, `.htaccess`). Then jump
to the section below. Always fill in real values; never ship placeholders.

Contents: [Next.js](#nextjs) · [Nuxt](#nuxt) · [Astro](#astro) ·
[SvelteKit](#sveltekit) · [Remix / React Router](#remix--react-router) ·
[Gatsby](#gatsby) · [WordPress](#wordpress) · [Plain HTML](#plain-html) ·
[Hosting & CDN](#hosting--cdn) · [Structured data](#structured-data) ·
[AI crawlers](#ai-crawlers)

## Next.js

**App Router** (`app/` directory):

| Finding                          | Fix                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Title / meta description         | `export const metadata = { title, description }` in `page.tsx`, or `generateMetadata()` for dynamic pages                    |
| Site-wide title pattern          | `title: { template: "%s · Brand", default: "Brand" }` in the root `app/layout.tsx`                                           |
| No canonical                     | Set `metadataBase: new URL("https://example.com")` in the root layout, then `alternates: { canonical: "/path" }` per page    |
| Open Graph missing               | `openGraph: { title, description, images }` in `metadata`; or an `opengraph-image.tsx` file in the route                     |
| robots.txt                       | `app/robots.ts` returning `MetadataRoute.Robots` (include `sitemap: "https://…/sitemap.xml"`)                                |
| sitemap.xml                      | `app/sitemap.ts` returning `MetadataRoute.Sitemap`; `generateSitemaps()` for large sites                                     |
| noindex where it shouldn't be    | Look for `robots: { index: false }` in `metadata` — often left in a shared layout from a staging setup                       |
| hreflang                         | `alternates: { languages: { "en-US": "/en-us", "de-DE": "/de" } }`                                                           |
| Images: dimensions / WebP / lazy | Use `next/image` — it sets width/height, lazy-loads, and serves WebP/AVIF. Mark the LCP image `priority` (`preload` in v16+) |
| Empty JS shell                   | A `"use client"` page that fetches in `useEffect`. Move data fetching into a Server Component or `generateStaticParams`      |
| Redirects                        | `redirects()` in `next.config.*` with `permanent: true` (sends 308, which search engines treat like 301)                     |
| Cache-Control / headers          | `headers()` in `next.config.*`; on Vercel, static pages are cached at the edge automatically                                 |

**Pages Router** (`pages/` directory): metadata goes in `next/head` inside each
page (or `_app.tsx` for defaults); robots.txt goes in `public/`; generate the
sitemap at build time (e.g. the `next-sitemap` package) or from
`pages/sitemap.xml.ts` with `getServerSideProps`.

## Nuxt

| Finding                   | Fix                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Title / description / OG  | `useSeoMeta({ title, description, ogTitle, ogDescription, ogImage })` in the page                          |
| Defaults for every page   | `app.head` in `nuxt.config.ts`, or `useHead` in `app.vue`                                                  |
| Canonical                 | `useHead({ link: [{ rel: "canonical", href: "https://…" }] })`                                             |
| sitemap.xml / robots.txt  | The `@nuxtjs/sitemap` and `@nuxtjs/robots` modules (both part of Nuxt SEO); set `site.url` in config       |
| Empty JS shell            | `ssr: false` in `nuxt.config.ts`, or a `routeRules` entry with `ssr: false` for the route — remove it      |
| Redirects / Cache-Control | `routeRules: { "/old": { redirect: { to: "/new", statusCode: 301 } }, "/**": { headers: { … } } }`         |
| Images                    | `@nuxt/image` (`<NuxtImg>` with `width`/`height`, `format="webp"`, `loading="lazy"` except the hero image) |

## Astro

| Finding           | Fix                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Title / meta / OG | In the shared layout's `<head>` (usually `src/layouts/*.astro`), fed by props from each page                                                |
| Canonical         | `<link rel="canonical" href={new URL(Astro.url.pathname, Astro.site)} />` — requires `site` in `astro.config.*`                             |
| sitemap.xml       | `@astrojs/sitemap` integration (needs `site`). It writes `sitemap-index.xml`; reference it from robots.txt or add a `/sitemap.xml` redirect |
| robots.txt        | `public/robots.txt`, or `src/pages/robots.txt.ts` to build it from `site`                                                                   |
| Images            | `<Image>` from `astro:assets` sets width/height and outputs WebP; use `loading="eager"` on the hero image                                   |
| Empty JS shell    | Rare in Astro; check for a page that renders only a `client:only` island                                                                    |

## SvelteKit

| Finding                  | Fix                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Title / meta / canonical | `<svelte:head>` in `+page.svelte` (per page) or `+layout.svelte` (defaults)                   |
| sitemap.xml              | `src/routes/sitemap.xml/+server.ts` returning XML with `Content-Type: application/xml`        |
| robots.txt               | `static/robots.txt`                                                                           |
| Empty JS shell           | `export const ssr = false` in a `+layout.ts` / `+page.ts` — remove it for pages meant to rank |
| Cache-Control            | `setHeaders({ "cache-control": "…" })` in `load`, or in `hooks.server.ts`                     |

## Remix / React Router

Titles and meta come from the route's `meta` export; the canonical goes in the
`links` export (or a `<link>` in `root.tsx` built from the request URL).
Serve `sitemap.xml` and `robots.txt` from resource routes (a route module that
only exports a `loader` returning a `Response` with the right content type).
Cache headers come from the `headers` export.

## Gatsby

Use the `Head` export in each page for title/meta/canonical (React Helmet is
legacy). `gatsby-plugin-sitemap` for the sitemap (it writes
`sitemap-index.xml`); `static/robots.txt` or `gatsby-plugin-robots-txt`.
`gatsby-plugin-image` handles dimensions, lazy-loading, and WebP/AVIF.

## WordPress

Check these settings **before** touching any theme code — they are the most
common causes of WordPress indexing failures:

- **Settings → Reading → "Discourage search engines from indexing this site"**
  must be unchecked. It adds a site-wide `noindex` and is routinely left on
  after launch.
- **Settings → Permalinks** should be "Post name" — `?p=123` URLs fail the
  clean-URL checks.

Then:

| Finding                       | Fix                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Title / meta / canonical / OG | An SEO plugin (Yoast SEO, Rank Math, SEOPress) — per post in the editor sidebar, defaults in the plugin's settings                  |
| sitemap.xml                   | WordPress core serves `/wp-sitemap.xml`; SEO plugins replace it with `/sitemap_index.xml` and usually redirect `/sitemap.xml` to it |
| robots.txt                    | Edit via the SEO plugin; a physical `robots.txt` file in the web root overrides the virtual one                                     |
| Multiple `<h1>`               | Usually the theme printing the site title as `<h1>` on every page — change it to a `<p>` or `<div>` in the header template          |
| Caching / compression         | A caching plugin (WP Rocket, LiteSpeed Cache, W3 Total Cache) or the host's built-in cache                                          |
| Slow LCP                      | Heavy theme or page builder, unoptimised hero image, too many plugins — measure with `run_lighthouse` before and after each change  |

## Plain HTML

Inside `<head>`:

```html
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Primary keyword – Brand</title>
<meta name="description" content="One or two sentences, ~150 characters, written for humans." />
<link rel="canonical" href="https://example.com/this-page" />
<meta property="og:title" content="Primary keyword – Brand" />
<meta property="og:description" content="…" />
<meta property="og:image" content="https://example.com/og.png" />
<meta property="og:url" content="https://example.com/this-page" />
```

Images: `<img src="photo.webp" width="800" height="600" alt="What it shows" loading="lazy">`
— but `loading="eager"` (or no attribute) and `fetchpriority="high"` on the
hero image.

## Hosting & CDN

Redirects, HTTPS, compression, and cache headers often live in the host, not
the app.

**Cache-Control that passes and makes sense:** HTML `no-cache` (revalidate on
every request — still passes the check, because ETag/Last-Modified make it
cheap); fingerprinted assets (`app.3f9a1c.js`) `public, max-age=31536000, immutable`.
Never give HTML a long `max-age` — users and crawlers would see stale pages.

**Vercel** — `vercel.json`:

```json
{
  "redirects": [{ "source": "/old", "destination": "/new", "permanent": true }],
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    }
  ]
}
```

HTTPS and compression are automatic. Pick one of apex or `www` as primary in
the project's Domains settings; the other then redirects to it.

**Netlify** — `_redirects` (`/old  /new  301`) and `_headers` files in the
publish directory, or the same rules in `netlify.toml`. HTTPS is automatic once
the certificate is provisioned.

**Cloudflare** — SSL/TLS → Edge Certificates → **Always Use HTTPS** for the
http→https redirect; **Redirect Rules** for path redirects; **Cache Rules** for
caching; compression is on by default.

**nginx:**

```nginx
server {
    listen 80;
    server_name example.com www.example.com;
    return 301 https://example.com$request_uri;
}
# in the https server block:
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;
location ~* \.(js|css|woff2|webp|avif)$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

**Apache** (`.htaccess`):

```apache
RewriteEngine On
RewriteCond %{HTTPS} off
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json
</IfModule>
```

## Structured data

Put JSON-LD in a `<script type="application/ld+json">` in the shared layout
(Organization, WebSite) and in page templates (Article, Product,
SoftwareApplication, BreadcrumbList). In React frameworks, serialize with
`JSON.stringify(data).replace(/</g, "\\u003c")` before injecting so page content
can't break out of the script tag.

- **Organization** — `name`, `url`, `logo`, and `sameAs` links to the real
  social and company profiles. This is what AI assistants use to identify the
  brand.
- **SoftwareApplication** — `name`, `description`, `applicationCategory`, and
  `offers` (with `price` and `priceCurrency`, `"0"` for free).
- **FAQPage** — fine to keep for AI answers; Google limits FAQ rich results to
  well-known government and health sites.
- **BreadcrumbList** — one `ListItem` per level with `position`, `name`, and `item`.

After changing it, re-run `check_structured_data`, and suggest Google's Rich
Results Test for Google-specific eligibility.

## AI crawlers

If `check_ai_crawlers` reports a bot as blocked:

1. Look for the rule in the repo's robots.txt (or the framework's robots
   generator above).
2. If it's not there, check the host. Cloudflare's AI crawler controls (block
   AI bots / managed robots.txt) can add rules and block requests that are
   absent from the repository's robots.txt. Some WordPress security plugins do
   the same.
3. Confirm with the user before unblocking anything — blocking AI training
   crawlers is often deliberate. `Google-Extended` controls Gemini training
   only; Google Search uses `Googlebot`.

`llms.txt` is optional and unofficial: a Markdown file at `/llms.txt` summarising
the site and linking to the most useful pages. Offer it; don't present it as
required.
