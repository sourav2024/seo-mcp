import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "./helpers/env.js";
import { auditHreflang, parseHreflangTags, hreflangValueProblem } from "../checks/hreflang.js";

/* ------------------------------------------------------------------ *
 * Fixture site: a US/Canada cluster plus the ways it goes wrong.
 * ------------------------------------------------------------------ */
let server;
let base;

const page = (lang, links, body = "content") => `<html lang="${lang}"><head>${links}</head><body>${body}</body></html>`;

before(async () => {
  server = http.createServer((req, res) => {
    const b = base;
    res.writeHead(200, { "content-type": "text/html" });
    switch (req.url) {
      // Correct reciprocal US/CA cluster with x-default.
      case "/us":
        return res.end(
          page(
            "en",
            `<link rel="alternate" hreflang="en-US" href="${b}/us">` +
              `<link rel="alternate" hreflang="en-CA" href="${b}/ca">` +
              `<link rel="alternate" hreflang="x-default" href="${b}/us">`
          )
        );
      case "/ca":
        return res.end(
          page(
            "en",
            `<link rel="alternate" hreflang="en-US" href="${b}/us">` +
              `<link rel="alternate" hreflang="en-CA" href="${b}/ca">` +
              `<link rel="alternate" hreflang="x-default" href="${b}/us">`
          )
        );
      // Points outward but /us never points back to it.
      case "/oneway":
        return res.end(
          page(
            "en",
            `<link rel="alternate" hreflang="en-CA" href="${b}/oneway">` +
              `<link rel="alternate" hreflang="en-US" href="${b}/us">`
          )
        );
      // No hreflang at all.
      case "/plain":
        return res.end(page("en", "<title>plain</title>"));
      // No <html lang>.
      case "/nolang":
        return res.end(`<html><head><title>t</title></head><body>content</body></html>`);
      // Same value twice, different targets.
      case "/dupe":
        return res.end(
          page(
            "en",
            `<link rel="alternate" hreflang="en-US" href="${b}/us">` +
              `<link rel="alternate" hreflang="en-US" href="${b}/ca">` +
              `<link rel="alternate" hreflang="x-default" href="${b}/dupe">`
          )
        );
      // Lists other locales but never itself, and uses a relative href.
      case "/noself":
        return res.end(
          page(
            "en",
            `<link rel="alternate" hreflang="en-US" href="${b}/us">` +
              `<link rel="alternate" hreflang="fr-CA" href="/fr-ca">`
          )
        );
      default:
        res.writeHead(404);
        return res.end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

/* ------------------------------------------------------------------ *
 * Unit: value validation
 * ------------------------------------------------------------------ */
describe("hreflangValueProblem", () => {
  test("accepts language-only, language-region, and script subtags", () => {
    for (const v of ["en", "fr", "en-US", "fr-CA", "es-419", "zh-Hant-TW"])
      assert.equal(hreflangValueProblem(v), null, `${v} should be valid`);
  });

  test("accepts x-default in any case", () => {
    assert.equal(hreflangValueProblem("x-default"), null);
    assert.equal(hreflangValueProblem("X-Default"), null);
  });

  test("accepts any casing — hreflang values are case-insensitive per spec", () => {
    // Real sites ship these: GitLab's entirely correct cluster is all-lowercase.
    // Matching canonical casing literally reported six valid tags as broken.
    for (const v of ["en-us", "de-de", "pt-br", "zh-hant-tw", "ZH-HANT-TW", "EN"])
      assert.equal(hreflangValueProblem(v), null, `${v} should be valid`);
  });

  test("case-insensitivity does not smuggle bad values through", () => {
    // The lowercase forms of the mistakes must still be caught.
    assert.match(hreflangValueProblem("en-uk"), /not an ISO 3166-1 country code/);
    assert.match(hreflangValueProblem("en-eu"), /not a country code/);
    assert.match(hreflangValueProblem("en_us"), /underscore/);
  });

  test("rejects an underscore and suggests the hyphen form", () => {
    const p = hreflangValueProblem("en_US");
    assert.match(p, /underscore/);
    assert.match(p, /en-US/);
  });

  test("rejects UK and suggests GB", () => {
    const p = hreflangValueProblem("en-UK");
    assert.match(p, /not an ISO 3166-1 country code/);
    assert.match(p, /en-GB/);
  });

  test("rejects pseudo-regions with no alpha-2 equivalent", () => {
    for (const v of ["en-EU", "en-ASIA", "en-GLOBAL"]) assert.match(hreflangValueProblem(v), /not a country code/);
  });

  test("rejects a malformed language subtag", () => {
    assert.match(hreflangValueProblem("english-US"), /not a valid language/);
  });
});

/* ------------------------------------------------------------------ *
 * Unit: tag extraction
 * ------------------------------------------------------------------ */
describe("parseHreflangTags", () => {
  test("extracts regardless of attribute order", () => {
    const tags = parseHreflangTags(
      `<link href="/a" hreflang="en-US" rel="alternate">` + `<link rel="alternate" hreflang="fr-CA" href="/b">`
    );
    assert.deepEqual(
      tags.map((t) => [t.lang, t.href]),
      [
        ["en-US", "/a"],
        ["fr-CA", "/b"],
      ]
    );
  });

  test("ignores hreflang on a non-alternate rel", () => {
    assert.equal(parseHreflangTags(`<link rel="canonical" hreflang="en-US" href="/a">`).length, 0);
  });

  test("returns nothing when no hreflang is present", () => {
    assert.equal(parseHreflangTags(`<link rel="alternate" href="/feed.xml">`).length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Integration: the audit report
 * ------------------------------------------------------------------ */
describe("auditHreflang", () => {
  test("a correct reciprocal US/CA cluster passes every check", async () => {
    const out = await auditHreflang(`${base}/us`, undefined, { verifyReturnLinks: true });
    assert.match(out, /✅ 3 hreflang annotations found/);
    assert.match(out, /✅ All hreflang values are well-formed/);
    assert.match(out, /✅ Page includes a self-referencing hreflang/);
    assert.match(out, /✅ x-default is present/);
    assert.match(out, /link back — the cluster is reciprocal/);
    assert.doesNotMatch(out, /❌/);
  });

  test('<html lang="en"> with hreflang="en-US" is not a mismatch', async () => {
    // Regression: comparing full values flagged the idiomatic language-only
    // lang attribute against a region-qualified hreflang.
    const out = await auditHreflang(`${base}/us`);
    assert.match(out, /✅ <html lang="en"> agrees/);
  });

  test("a missing return link is reported as a failure", async () => {
    const out = await auditHreflang(`${base}/oneway`, undefined, { verifyReturnLinks: true });
    assert.match(out, /❌ 1 alternate\(s\) do not link back/);
    assert.match(out, /reciprocal/);
  });

  test("return-link verification is off by default", async () => {
    const out = await auditHreflang(`${base}/oneway`);
    assert.match(out, /Return-link verification skipped/);
    assert.doesNotMatch(out, /do not link back/);
  });

  test("a single-language page is told hreflang is optional, not broken", async () => {
    const out = await auditHreflang(`${base}/plain`);
    assert.match(out, /No hreflang annotations found/);
    assert.match(out, /that is correct/);
    assert.doesNotMatch(out, /❌/);
  });

  test("missing <html lang> is warned about even with no hreflang", async () => {
    const out = await auditHreflang(`${base}/nolang`);
    assert.match(out, /No <html lang> attribute/);
  });

  test("conflicting duplicate values fail", async () => {
    const out = await auditHreflang(`${base}/dupe`);
    assert.match(out, /❌ Conflicting duplicate hreflang value\(s\): en-US/);
  });

  test("a cluster that omits itself fails the self-reference check", async () => {
    const out = await auditHreflang(`${base}/noself`, undefined, {});
    assert.match(out, /❌ No self-referencing hreflang/);
  });

  test("a relative href is flagged", async () => {
    const out = await auditHreflang(`${base}/noself`);
    assert.match(out, /relative/);
  });
});
