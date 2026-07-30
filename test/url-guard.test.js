/**
 * Tests for URL validation and SSRF guards — the security-critical boundary
 * between user input and fetch(). Fully offline.
 */
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  isPrivateHost,
  assertFetchableUrl,
  assertRedirectTarget,
  parseUrlOrThrow,
  UrlValidationError,
} from "../src/url-guard.js";

/* ---------------- normalizeUrl ---------------- */

test("normalizeUrl adds https:// to bare hostnames", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("example.com/path"), "https://example.com/path");
  assert.equal(normalizeUrl("  example.com  "), "https://example.com");
});

test("normalizeUrl preserves an explicit scheme, including non-http ones", () => {
  assert.equal(normalizeUrl("http://example.com"), "http://example.com");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com");
  // Preserved here so assertFetchableUrl can reject it with a clear message.
  assert.equal(normalizeUrl("file:///etc/passwd"), "file:///etc/passwd");
});

test("normalizeUrl rejects non-strings and empty input", () => {
  for (const bad of [null, undefined, 42, {}, [], "", "   "]) {
    assert.throws(() => normalizeUrl(bad), UrlValidationError, `should reject ${JSON.stringify(bad)}`);
  }
});

/* ---------------- Scheme validation ---------------- */

test("only http and https are fetchable", () => {
  for (const scheme of ["file", "data", "ftp", "gopher", "javascript", "jar", "about", "blob"]) {
    assert.throws(
      () => assertFetchableUrl(`${scheme}://example.com/x`),
      (e) => e instanceof UrlValidationError && /http:\/\/ or https:\/\//.test(e.message),
      `${scheme}: should be rejected`
    );
  }
  assert.ok(assertFetchableUrl("http://example.com"));
  assert.ok(assertFetchableUrl("https://example.com"));
});

test("absurdly long URLs are rejected before any network call", () => {
  assert.throws(() => assertFetchableUrl(`https://example.com/${"a".repeat(3000)}`), UrlValidationError);
});

test("malformed URLs produce a clear error, not a TypeError", () => {
  assert.throws(() => assertFetchableUrl("https://"), UrlValidationError);
  assert.throws(() => assertFetchableUrl("http://["), UrlValidationError);
});

test("error messages include the caller-supplied context", () => {
  assert.throws(() => assertFetchableUrl("file:///x", { context: "Lighthouse URL" }), /Lighthouse URL must use/);
});

/* ---------------- Hostname validation ---------------- */

test("hostnames DNS could never resolve are rejected", () => {
  // A mistyped scheme ("ht!tp://x") collapses into the host "ht!tp", which the
  // URL parser accepts but DNS does not — it used to surface as "fetch failed".
  for (const bad of ["ht!tp://x", "https://ho st.com", "https://-lead.com", "https://trail-.com", "https://a..b.com"]) {
    assert.throws(
      () => assertFetchableUrl(bad),
      (e) => e instanceof UrlValidationError,
      `${bad} should be rejected`
    );
  }
});

test("valid hostname forms are still accepted", () => {
  const good = [
    "example.com",
    "sub.domain.example.co.uk",
    "http://localhost:3000",
    "http://127.0.0.1:8080",
    "https://xn--80ak6aa92e.com", // IDN punycode
    "https://[::1]:8080", // IPv6 literal
    "https://a-b-c.example.com",
    "https://example.com.", // trailing dot is legal
  ];
  for (const u of good) assert.ok(assertFetchableUrl(u), `${u} should be accepted`);
});

test("parseUrlOrThrow applies the same validation as assertFetchableUrl", () => {
  // Checks call parseUrlOrThrow directly when imported as a library, so it must
  // not be a weaker gate than the MCP entry point.
  assert.throws(() => parseUrlOrThrow("ht!tp://x"), UrlValidationError);
  assert.throws(() => parseUrlOrThrow("file:///etc/passwd"), UrlValidationError);
  assert.equal(parseUrlOrThrow("example.com").href, "https://example.com/");
});

/* ---------------- Private-host detection ---------------- */

test("loopback, private, and link-local addresses are detected", () => {
  const privateHosts = [
    "127.0.0.1",
    "127.53.1.9",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata — the classic SSRF target
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "224.0.0.1", // multicast
    "localhost",
    "app.localhost",
    "printer.local",
    "db.internal",
    "svc.home.arpa",
    "intranet", // no dot: only resolvable inside a network
    "::1",
    "::",
    "[::1]",
    "fd00::1", // unique-local
    "fe80::1", // link-local
    "::ffff:127.0.0.1", // IPv4-mapped loopback
  ];
  for (const h of privateHosts) assert.equal(isPrivateHost(h), true, `${h} should be private`);
});

test("public hosts are not flagged as private", () => {
  const publicHosts = [
    "example.com",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // just outside 172.16/12
    "11.0.0.1", // just outside 10/8
    "192.169.0.1", // just outside 192.168/16
    "sub.domain.example.co.uk",
    "2606:4700::1111",
  ];
  for (const h of publicHosts) assert.equal(isPrivateHost(h), false, `${h} should be public`);
});

test("private hosts are allowed by default (auditing localhost is a core use case)", () => {
  // config.allowPrivateHosts defaults to true, so this must not throw.
  assert.ok(assertFetchableUrl("http://localhost:3000"));
  assert.ok(assertFetchableUrl("http://127.0.0.1:8080/page"));
});

/* ---------------- Redirect guards ---------------- */

test("redirect targets are resolved relative to the current URL", () => {
  const next = assertRedirectTarget("/new-path", "https://example.com/old");
  assert.equal(next.href, "https://example.com/new-path");
});

test("a redirect to a non-HTTP scheme is blocked", () => {
  assert.throws(
    () => assertRedirectTarget("file:///etc/passwd", "https://example.com"),
    (e) => e instanceof UrlValidationError && /non-HTTP scheme/.test(e.message)
  );
});

test("a malformed Location header is rejected cleanly", () => {
  assert.throws(() => assertRedirectTarget("http://[", "https://example.com"), UrlValidationError);
});
