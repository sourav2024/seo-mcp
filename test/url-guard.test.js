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
  assertResolvesPublic,
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
    "::ffff:7f00:1", // the same, in the hex form the URL parser produces
    "[::ffff:a9fe:a9fe]", // IPv4-mapped 169.254.169.254 (cloud metadata)
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

test("a bracketed IPv4-mapped URL is recognized after the parser rewrites it to hex", () => {
  // new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"
  assert.equal(isPrivateHost(new URL("http://[::ffff:127.0.0.1]/").hostname), true);
  assert.equal(isPrivateHost(new URL("http://[::ffff:8.8.8.8]/").hostname), false);
});

/* ---------------- Resolved-address guard ---------------- */

/** A fake dns.promises.lookup returning fixed addresses. */
const lookupReturning =
  (...addresses) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("a public hostname resolving to a private address is blocked", async () => {
  for (const addr of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    await assert.rejects(
      assertResolvesPublic("https://rebind.example.com/", { allowPrivate: false, lookup: lookupReturning(addr) }),
      UrlValidationError,
      `${addr} should be blocked`
    );
  }
});

test("one private address among several is enough to block", async () => {
  await assert.rejects(
    assertResolvesPublic("https://mixed.example.com/", {
      allowPrivate: false,
      lookup: lookupReturning("93.184.216.34", "127.0.0.1"),
    }),
    /resolves to a private address \(127\.0\.0\.1\)/
  );
});

test("public resolutions pass", async () => {
  await assertResolvesPublic("https://example.com/", {
    allowPrivate: false,
    lookup: lookupReturning("93.184.216.34", "2606:2800:220:1::1"),
  });
});

test("the resolved-address check is skipped entirely while private hosts are allowed", async () => {
  let called = false;
  await assertResolvesPublic("https://example.com/", {
    allowPrivate: true,
    lookup: async () => {
      called = true;
      return [];
    },
  });
  assert.equal(called, false, "no DNS lookup should happen in the default mode");
});

test("IP literals and unresolvable hosts are left to the other guards", async () => {
  const neverCalled = async () => assert.fail("lookup should not run for an IP literal");
  await assertResolvesPublic("http://93.184.216.34/", { allowPrivate: false, lookup: neverCalled });
  await assertResolvesPublic("http://[2606:2800:220:1::1]/", { allowPrivate: false, lookup: neverCalled });
  const failing = async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  };
  await assertResolvesPublic("https://no-such-host.invalid/", { allowPrivate: false, lookup: failing });
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
