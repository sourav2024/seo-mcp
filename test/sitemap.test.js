/**
 * Sitemap discovery: robots.txt `Sitemap:` lines first, then /sitemap.xml, then
 * the well-known index names — so index-based sites (Astro, Gatsby, Yoast,
 * WordPress core) aren't falsely reported as having no sitemap. Each test swaps
 * in its own site layout on one local fixture server.
 */
import "./helpers/env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auditSitemap, collectSitemapUrls, parseRobotsSitemaps } from "../checks/index.js";

let server;
let origin;
/** path → { type, body } for the current test; bodies may use {origin}. */
let site = {};

const urlset = (...paths) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<url><loc>{origin}${p}</loc><lastmod>2026-10-01</lastmod></url>`)
    .join("")}</urlset>`;
const sitemapIndex = (...paths) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
    .map((p) => `<sitemap><loc>{origin}${p}</loc></sitemap>`)
    .join("")}</sitemapindex>`;
const xml = (body) => ({ type: "application/xml", body });
const text = (body) => ({ type: "text/plain", body });
const page = { type: "text/html", body: "<html><head><title>ok</title></head><body>ok</body></html>" };

before(async () => {
  server = createServer((req, res) => {
    const route = site[new URL(req.url, "http://x").pathname];
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": route.type });
    res.end(route.body.replaceAll("{origin}", origin));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("parseRobotsSitemaps reads every Sitemap: line, in any case, outside any group", () => {
  const robots = [
    "Sitemap: https://example.com/sitemap-index.xml",
    "User-agent: *",
    "Disallow: /admin",
    "sitemap:https://example.com/news.xml",
    "  SITEMAP :  /relative.xml",
    "Sitemap: https://example.com/sitemap-index.xml", // duplicate
    "Sitemap: ftp://example.com/nope.xml", // not http(s)
    "# Sitemap: https://example.com/commented.xml",
  ].join("\n");
  assert.deepEqual(parseRobotsSitemaps(robots, "https://example.com"), [
    "https://example.com/sitemap-index.xml",
    "https://example.com/news.xml",
    "https://example.com/relative.xml",
  ]);
  assert.deepEqual(parseRobotsSitemaps("", "https://example.com"), []);
});

test("a sitemap index declared in robots.txt passes even with no /sitemap.xml (Astro, Gatsby)", async () => {
  site = {
    "/robots.txt": text("User-agent: *\nAllow: /\nSitemap: {origin}/sitemap-index.xml\n"),
    "/sitemap-index.xml": xml(sitemapIndex("/sitemap-0.xml")),
    "/sitemap-0.xml": xml(urlset("/", "/about")),
    "/": page,
    "/about": page,
  };
  const report = await auditSitemap(origin);
  assert.doesNotMatch(report, /❌/, report);
  assert.match(report, /✅ Sitemap declared in robots\.txt/);
  assert.match(report, /sitemap-index\.xml exists \(sitemap index/);
  // The index's first child is sampled, so its pages are actually checked.
  assert.match(report, /Sampling URLs from the first child sitemap: .*\/sitemap-0\.xml/);
  assert.match(report, /✅ Sampled 2\/2 URLs — all return 200/);
  assert.match(report, /✅ lastmod present on 2 entries/);
});

test("an undeclared sitemap at a well-known index path is a warning, not a failure (Yoast)", async () => {
  site = {
    "/robots.txt": text("User-agent: *\nAllow: /\n"),
    "/sitemap_index.xml": xml(sitemapIndex("/post-sitemap.xml")),
    "/post-sitemap.xml": xml(urlset("/")),
    "/": page,
  };
  const report = await auditSitemap(origin);
  assert.match(report, /⚠️ Found .*\/sitemap_index\.xml, but it isn't declared in robots\.txt/);
  assert.match(report, /Add "Sitemap: .*\/sitemap_index\.xml" to robots\.txt/);
  assert.doesNotMatch(report, /❌/, report);
});

test("/sitemap.xml still works on its own when robots.txt declares nothing", async () => {
  site = { "/sitemap.xml": xml(urlset("/")), "/": page };
  const report = await auditSitemap(origin);
  assert.match(report, /✅ .*\/sitemap\.xml exists \(urlset, 1 <loc> entries\)/);
  assert.doesNotMatch(report, /declared in robots|isn't declared/);
});

test("no sitemap anywhere is a failure that lists where it looked", async () => {
  site = { "/robots.txt": text("User-agent: *\nAllow: /\n") };
  const report = await auditSitemap(origin);
  assert.match(report, /❌ No sitemap found: robots\.txt declares none, .*\/sitemap\.xml returned HTTP 404/);
  assert.match(report, /sitemap-index\.xml, \/sitemap_index\.xml, \/wp-sitemap\.xml/);
});

test("an SPA that answers /sitemap.xml with its HTML shell is not mistaken for a sitemap", async () => {
  site = { "/sitemap.xml": page };
  const report = await auditSitemap(origin);
  assert.match(report, /❌ No sitemap found: .*returned a page that is not an XML sitemap/);
});

test("a declared sitemap that 404s is a failure naming the robots.txt line", async () => {
  site = {
    "/robots.txt": text("Sitemap: {origin}/gone.xml\n"),
    "/sitemap.xml": xml(urlset("/")), // present, but crawlers follow the declaration
  };
  const report = await auditSitemap(origin);
  assert.match(report, /❌ robots\.txt declares .*\/gone\.xml, but it returned HTTP 404/);
});

test("when several sitemaps are declared, the first that responds is checked", async () => {
  site = {
    "/robots.txt": text("Sitemap: {origin}/gone.xml\nSitemap: {origin}/pages.xml\n"),
    "/pages.xml": xml(urlset("/")),
    "/": page,
  };
  const report = await auditSitemap(origin);
  assert.match(report, /✅ Sitemap declared in robots\.txt \(2 declared/);
  assert.match(report, /pages\.xml exists/);
});

test("a broken child sitemap in an index is a failure", async () => {
  site = {
    "/robots.txt": text("Sitemap: {origin}/sitemap-index.xml\n"),
    "/sitemap-index.xml": xml(sitemapIndex("/sitemap-0.xml")),
  };
  const report = await auditSitemap(origin);
  assert.match(report, /❌ Child sitemap .*\/sitemap-0\.xml returned HTTP 404/);
});

test("crawl seeding follows robots.txt-declared index sitemaps", async () => {
  site = {
    "/robots.txt": text("Sitemap: {origin}/sitemap-index.xml\n"),
    "/sitemap-index.xml": xml(sitemapIndex("/sitemap-0.xml", "/sitemap-1.xml")),
    "/sitemap-0.xml": xml(urlset("/", "/a")),
    "/sitemap-1.xml": xml(urlset("/b")),
  };
  const urls = await collectSitemapUrls(origin);
  assert.deepEqual(urls.sort(), [`${origin}/`, `${origin}/a`, `${origin}/b`]);
});
