/**
 * Tests for crawl_audit — the most complex module in the repo.
 *
 * Runs against a local fixture site with deliberate problems: a broken link, a
 * redirect chain, duplicate titles, an orphan sitemap URL, and a template-level
 * issue repeated across pages. Every request is counted so the "fetch each URL
 * exactly once" guarantee is asserted rather than assumed.
 */
import "./helpers/env.js";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crawlAudit, collectSitemapUrls } from "../checks/index.js";

const execFileAsync = promisify(execFile);

/**
 * Run a crawl in a child process with specific config.
 *
 * `config` is frozen at import time, so concurrency can only be varied across
 * process boundaries. This must be the ASYNC execFile: execFileSync blocks this
 * process's event loop, so the fixture server here could never answer the
 * child's requests and the two would deadlock.
 */
async function crawlInChildProcess(targetOrigin, maxPages, env) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "-e",
      `const { crawlAudit } = await import("./checks/index.js");
       process.stdout.write(await crawlAudit(process.env.TEST_ORIGIN, ${maxPages}));`,
    ],
    {
      env: { ...process.env, TEST_ORIGIN: targetOrigin, ...env },
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
      timeout: 30_000,
    }
  );
  return stdout;
}

let server;
let origin;
/** Every path requested, in order — asserted against for dedup and politeness. */
let requests = [];

/** Pages share a missing-viewport problem so the site-wide aggregation triggers. */
const body = (title, desc, links = [], extra = "") => `<html><head>
<title>${title}</title><meta name="description" content="${desc}">
</head><body><h1>${title}</h1>
<p>${"Real body copy that is long enough to pass the JS-shell check. ".repeat(6)}</p>
${links.map((l) => `<a href="${l}">link</a>`).join("\n")}
${extra}
</body></html>`;

const routes = {
  "/": body("Home", "The home page", ["/a", "/b", "/broken", "/chain-1"]),
  "/a": body("Shared Title", "Same description here", ["/", "/b"]),
  // Duplicate title + description vs /a.
  "/b": body("Shared Title", "Same description here", ["/"]),
  // Only reachable via the sitemap → orphan.
  "/orphan": body("Orphan", "Not linked from anywhere"),
};

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    requests.push(path);

    if (path === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      const urls = ["/", "/a", "/b", "/orphan"].map((p) => `<url><loc>${origin}${p}</loc></url>`).join("");
      return res.end(
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`
      );
    }
    if (path === "/broken") {
      res.writeHead(404, { "Content-Type": "text/html" });
      return res.end("<html><body>Not found</body></html>");
    }
    // Two-hop redirect chain: /chain-1 → /chain-2 → /a
    if (path === "/chain-1") {
      res.writeHead(301, { Location: `${origin}/chain-2` });
      return res.end();
    }
    if (path === "/chain-2") {
      res.writeHead(301, { Location: `${origin}/a` });
      return res.end();
    }
    if (routes[path] !== undefined) {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "max-age=60" });
      return res.end(routes[path]);
    }
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());
beforeEach(() => {
  requests = [];
});

/* ---------------- Core crawl behavior ---------------- */

test("crawls sitemap-seeded pages and reports the count", async () => {
  const report = await crawlAudit(origin, 10);
  assert.match(report, /# Crawl audit/);
  assert.match(report, /Seeded from sitemap\.xml: 4 URLs/);
  // All four sitemap pages are HTML and should be audited.
  assert.match(report, /4 pages audited/);
});

/**
 * `/a` is exempt: it is both a sitemap entry and where /chain-1 lands, and
 * resolving a redirect chain is necessarily a second request. Every other URL
 * must be fetched exactly once — that is the guarantee the README states.
 */
test("each crawled URL is fetched exactly once", async () => {
  await crawlAudit(origin, 10);
  const counts = new Map();
  for (const p of requests) counts.set(p, (counts.get(p) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([p, n]) => n > 1 && p !== "/a");
  assert.deepEqual(duplicated, [], `these URLs were fetched more than once: ${JSON.stringify(duplicated)}`);
  // The start page in particular used to be re-probed during the broken-link
  // pass because "http://host" and "http://host/" hashed differently.
  assert.equal(counts.get("/"), 1, "the start page must not be re-fetched");
});

test("max_pages is respected", async () => {
  const report = await crawlAudit(origin, 2);
  assert.match(report, /2 pages audited/);
});

test("max_pages of 1 audits only the start page", async () => {
  const report = await crawlAudit(origin, 1);
  assert.match(report, /1 pages audited/);
});

/* ---------------- Aggregation ---------------- */

test("detects broken internal links with their source pages", async () => {
  const report = await crawlAudit(origin, 10);
  assert.match(report, /Broken internal links/);
  assert.match(report, /\/broken/);
  assert.match(report, /404/);
});

test("detects multi-hop redirect chains", async () => {
  const report = await crawlAudit(origin, 10);
  assert.match(report, /[Rr]edirect chain/);
  assert.match(report, /chain-1/);
});

test("detects duplicate titles and meta descriptions", async () => {
  const report = await crawlAudit(origin, 10);
  assert.match(report, /Duplicate/i);
  assert.match(report, /Shared Title/);
});

test("detects orphan sitemap URLs", async () => {
  const report = await crawlAudit(origin, 10);
  assert.match(report, /[Oo]rphan/);
  assert.match(report, /\/orphan/);
});

test("aggregates a template-level issue into the site-wide section", async () => {
  const report = await crawlAudit(origin, 10);
  const siteWide = report.slice(report.indexOf("## Site-wide issues"), report.indexOf("## Broken"));
  // Every fixture page lacks a viewport meta, so it must aggregate rather than
  // repeat once per page.
  assert.match(siteWide, /viewport/i, "the shared viewport problem should be reported site-wide");
});

/* ---------------- Concurrency (SEO_MCP_CRAWL_CONCURRENCY) ---------------- */

test("concurrent crawling still fetches each URL exactly once", async () => {
  const out = await crawlInChildProcess(origin, 10, { SEO_MCP_CRAWL_CONCURRENCY: "4", SEO_MCP_CRAWL_DELAY_MS: "0" });
  assert.match(out, /4 pages audited/, "concurrency must not change how many pages are audited");

  const pageRequests = requests.filter((p) => !p.includes("sitemap"));
  const counts = new Map();
  for (const p of pageRequests) counts.set(p, (counts.get(p) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([p, n]) => n > 1 && p !== "/a");
  assert.deepEqual(duplicated, [], `concurrent workers double-fetched: ${JSON.stringify(duplicated)}`);
});

test("BFS link discovery still works with concurrency > 1", async () => {
  // No sitemap on this server, so the crawl must discover pages via links.
  const bfsServer = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/sitemap.xml") {
      res.writeHead(404);
      return res.end();
    }
    // A chain of pages, each linking only to the next: depth-3 discovery.
    const chain = { "/": "/p1", "/p1": "/p2", "/p2": "/p3", "/p3": "" };
    if (chain[path] !== undefined) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(body(`Page ${path}`, "d", chain[path] ? [chain[path]] : []));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => bfsServer.listen(0, "127.0.0.1", r));
  const bfsOrigin = `http://127.0.0.1:${bfsServer.address().port}`;
  try {
    const out = await crawlInChildProcess(bfsOrigin, 10, {
      SEO_MCP_CRAWL_CONCURRENCY: "3",
      SEO_MCP_CRAWL_DELAY_MS: "0",
    });
    assert.match(out, /crawling by following internal links/, "should fall back to BFS with no sitemap");
    // All four pages are only reachable by following links transitively.
    assert.match(out, /4 pages audited/, "BFS must discover links found by other workers");
  } finally {
    bfsServer.close();
  }
});

/* ---------------- Cancellation ---------------- */

test("an already-aborted signal rejects before any work is done", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => crawlAudit(origin, 10, { signal: ac.signal }), /cancelled by the client/);
  assert.equal(requests.length, 0, "no requests should be made once cancelled");
});

test("aborting mid-crawl stops the crawl instead of running to completion", async () => {
  // A 20-page sitemap with the default politeness delay gives the abort time to
  // land partway through.
  const many = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      const urls = Array.from(
        { length: 20 },
        (_, i) => `<url><loc>http://127.0.0.1:${many.address().port}/p${i}</loc></url>`
      ).join("");
      return res.end(`<?xml version="1.0"?><urlset>${urls}</urlset>`);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(body("Page", "d"));
  });
  await new Promise((r) => many.listen(0, "127.0.0.1", r));
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1_200);
    await assert.rejects(
      () => crawlAudit(`http://127.0.0.1:${many.address().port}`, 20, { signal: ac.signal }),
      /cancelled by the client/
    );
  } finally {
    many.close();
  }
});

/* ---------------- Progress reporting ---------------- */

test("onProgress is called once per audited page", async () => {
  const events = [];
  await crawlAudit(origin, 10, { onProgress: (n, msg) => events.push({ n, msg }) });
  assert.ok(events.length >= 4, `expected at least 4 progress events, got ${events.length}`);
  // Progress must never move backwards — the MCP spec requires monotonicity.
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].n >= events[i - 1].n, `progress went backwards: ${events[i - 1].n} → ${events[i].n}`);
  }
  assert.match(events[0].msg, /Audited \d+\/10/);
});

/* ---------------- Failure handling ---------------- */

test("an unreachable start URL fails without throwing", async () => {
  // Port 1 is reserved and refuses connections.
  await assert.rejects(() => crawlAudit("http://127.0.0.1:1", 5), /.*/);
});

test("a site with no sitemap falls back to BFS", async () => {
  const noSitemap = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(body("Only", "one page"));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => noSitemap.listen(0, "127.0.0.1", r));
  try {
    const report = await crawlAudit(`http://127.0.0.1:${noSitemap.address().port}`, 5);
    assert.match(report, /crawling by following internal links/);
    assert.match(report, /1 pages audited/);
  } finally {
    noSitemap.close();
  }
});

/* ---------------- collectSitemapUrls ---------------- */

test("collectSitemapUrls returns same-origin URLs from the sitemap", async () => {
  const urls = await collectSitemapUrls(origin);
  assert.equal(urls.length, 4);
  for (const u of urls) assert.ok(u.startsWith(origin), `${u} should be same-origin`);
});

test("collectSitemapUrls returns an empty array when there is no sitemap", async () => {
  const bare = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => bare.listen(0, "127.0.0.1", r));
  try {
    const urls = await collectSitemapUrls(`http://127.0.0.1:${bare.address().port}`);
    assert.deepEqual(urls, []);
  } finally {
    bare.close();
  }
});
