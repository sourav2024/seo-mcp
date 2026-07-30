import "./helpers/env.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  auditPageEssentials,
  auditRendering,
  auditRobots,
  auditSitemap,
  auditStructuredData,
  auditAiCrawlers,
  auditKeywordPlacement,
  httpRedirectLine,
  parseRobotsGroups,
  botRobotsStatus,
  countPhrase,
} from "../checks/index.js";

let server;
let origin;

/* ---------------- Fixture pages (deliberately broken) ---------------- */
const LONG_TEXT = "freight brokers move loads every day. ".repeat(30);

const routes = {
  // Missing <title>, two <h1>s, img without width/height, no viewport meta
  "/broken.html": {
    type: "text/html",
    body: `<html><head><meta name="description" content="A page."></head>
<body><h1>One</h1><h1>Two</h1><img src="a.jpg"><p>${LONG_TEXT}</p></body></html>`,
  },
  // Healthy page for keyword checks — singular "freight broker" in title/h1,
  // plural "brokers" in body (stem tolerance must bridge them)
  "/keyword.html": {
    type: "text/html",
    body: `<html><head><title>Freight Broker TMS</title>
<meta name="viewport" content="width=device-width"><meta name="description" content="TMS for freight brokers."></head>
<body><h1>Freight broker software</h1><p>${LONG_TEXT}</p></body></html>`,
  },
  // robots.txt with a blanket Disallow under *
  "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /\n" },
  // JSON-LD with a syntax error (trailing comma)
  "/jsonld.html": {
    type: "text/html",
    body: `<html><head><title>x</title><script type="application/ld+json">{"@type": "Organization",}</script></head><body><p>${LONG_TEXT}</p></body></html>`,
  },
  // Page served with X-Robots-Tag: noindex
  "/noindex.html": {
    type: "text/html",
    headers: { "X-Robots-Tag": "noindex, nofollow" },
    body: `<html><head><title>x</title></head><body><p>${LONG_TEXT}</p></body></html>`,
  },
  "/exists.html": { type: "text/html", body: "<html><head><title>ok</title></head><body>ok</body></html>" },
};

function handler(req, res) {
  const path = new URL(req.url, "http://x").pathname;
  // sitemap is generated per-run so <loc> carries the ephemeral port
  if (path === "/sitemap.xml") {
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${origin}/missing.html</loc></url>
<url><loc>${origin}/exists.html</loc></url>
</urlset>`);
    return;
  }
  // http→https via temporary 302 (should be a 301)
  if (path === "/redirect-http") {
    res.writeHead(302, { Location: "https://example.com/" });
    res.end();
    return;
  }
  const route = routes[path];
  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": route.type, ...(route.headers || {}) });
  res.end(route.body);
}

before(async () => {
  server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

/* ---------------- Page essentials ---------------- */
test("missing <title> is a failure", async () => {
  const report = await auditPageEssentials(`${origin}/broken.html`);
  assert.match(report, /❌ Missing <title>\./);
});

test("two <h1> tags are a warning", async () => {
  const report = await auditPageEssentials(`${origin}/broken.html`);
  assert.match(report, /⚠️ 2 <h1> tags — use exactly one\./);
});

test("missing viewport meta is a failure", async () => {
  const report = await auditPageEssentials(`${origin}/broken.html`);
  assert.match(report, /❌ Missing responsive viewport meta/);
});

test("img without width/height is flagged as CLS risk (warning)", async () => {
  const report = await auditPageEssentials(`${origin}/broken.html`);
  assert.match(report, /⚠️ 1\/1 images missing explicit width\/height/);
});

/* ---------------- Rendering ---------------- */
test("page with real text passes rendering; thin shell fails", async () => {
  assert.match(await auditRendering(`${origin}/broken.html`), /✅ Server returns rendered HTML/);
  assert.match(await auditRendering(`${origin}/exists.html`), /❌ Page appears to be a client-side JS shell/);
});

/* ---------------- HTTPS redirect classification ---------------- */
test("http→https via temporary 302 is a warning (should be 301)", async () => {
  const line = await httpRedirectLine(`${origin}/redirect-http`);
  assert.match(line, /^⚠️ http:\/\/ redirects to https:\/\/ but with a temporary 302/);
});

test("http response without https redirect is a failure", async () => {
  const line = await httpRedirectLine(`${origin}/exists.html`);
  assert.match(line, /^❌ http:\/\/ returned 200 without redirecting/);
});

/* ---------------- Robots ---------------- */
test("blanket Disallow: / in robots.txt is a failure", async () => {
  const report = await auditRobots(origin);
  assert.match(report, /❌ Contains 'Disallow: \/' — the ENTIRE site is blocked/);
});

test("robots parser: blanket * block applies to AI bots without own groups", () => {
  const groups = parseRobotsGroups("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n");
  assert.equal(botRobotsStatus(groups, "GPTBot").blocked, false);
  assert.equal(botRobotsStatus(groups, "GPTBot").viaOwnGroup, true);
  assert.equal(botRobotsStatus(groups, "ClaudeBot").blocked, true);
  assert.equal(botRobotsStatus(groups, "ClaudeBot").viaOwnGroup, false);
});

test("check_ai_crawlers fails bots blocked by blanket * Disallow", async () => {
  const report = await auditAiCrawlers(`${origin}/exists.html`);
  assert.match(report, /❌ GPTBot: blocked by a blanket "Disallow: \/"/);
  assert.match(report, /❌ ClaudeBot: blocked by a blanket "Disallow: \/"/);
});

test("X-Robots-Tag: noindex header is a failure", async () => {
  const report = await auditAiCrawlers(`${origin}/noindex.html`);
  assert.match(report, /❌ X-Robots-Tag response header contains "noindex, nofollow"/);
});

/* ---------------- Sitemap ---------------- */
test("sitemap <loc> returning 404 is a failure; missing lastmod is a warning", async () => {
  const report = await auditSitemap(origin);
  assert.match(report, /❌ .*\/missing\.html returns HTTP 404/);
  assert.match(report, /⚠️ No lastmod values/);
});

/* ---------------- Structured data ---------------- */
test("malformed JSON-LD is a failure with parse position", async () => {
  const report = await auditStructuredData(`${origin}/jsonld.html`);
  assert.match(report, /❌ JSON-LD block 1 of 1 is malformed/);
});

test("page without JSON-LD fails with a ready-to-paste Organization example", async () => {
  const report = await auditStructuredData(`${origin}/broken.html`);
  assert.match(report, /❌ No JSON-LD structured data found/);
  assert.match(report, /"@type": "Organization"/);
});

/* ---------------- Keywords (stem tolerance) ---------------- */
test("countPhrase bridges singular and plural", () => {
  assert.ok(countPhrase("we serve freight brokers daily", "freight broker") > 0);
  assert.ok(countPhrase("a freight broker's day", "freight brokers") > 0);
  assert.equal(countPhrase("freight forwarding only", "freight broker"), 0);
});

test("keyword placement matches plural body text against singular keyword", async () => {
  const report = await auditKeywordPlacement(`${origin}/keyword.html`, "freight broker");
  assert.match(report, /✅ Keyword in <title>/);
  assert.match(report, /✅ Keyword in <h1>/);
  assert.doesNotMatch(report, /❌ Keyword does not appear in the body content/);
});
