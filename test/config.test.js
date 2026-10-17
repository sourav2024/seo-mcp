/**
 * Tests for configuration parsing and the error-message mapping that shapes
 * what users actually see when a fetch fails.
 *
 * Env-var parsing is exercised in child processes: `config` is frozen at import
 * time (deliberately — validate once at startup), so mutating process.env in
 * this process would have no effect.
 */
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.js";
import { describeError, toolError, ok, guard } from "../src/tool-result.js";
import { UrlValidationError } from "../src/url-guard.js";

/** Read the parsed config from a child process with the given env. */
function configWith(env) {
  const out = execFileSync(
    process.execPath,
    ["-e", 'import("./src/config.js").then(m => process.stdout.write(JSON.stringify(m.config)))'],
    { env: { ...process.env, ...env }, cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" }
  );
  return JSON.parse(out);
}

/* ---------------- Defaults ---------------- */

test("defaults are sensible and documented", () => {
  assert.equal(config.logLevel, "info");
  assert.equal(config.logFormat, "json");
  assert.equal(config.fetchTimeoutMs, 20_000);
  assert.equal(config.maxBodyBytes, 10 * 1024 * 1024);
  assert.equal(config.crawlDelayMs, 500);
  assert.equal(config.allowPrivateHosts, true, "auditing localhost must work out of the box");
});

test("config is frozen so nothing can mutate it at runtime", () => {
  assert.throws(() => {
    config.fetchTimeoutMs = 1;
  }, TypeError);
});

/* ---------------- Validation ---------------- */

test("valid env overrides are applied", () => {
  const c = configWith({ SEO_MCP_FETCH_TIMEOUT_MS: "5000", SEO_MCP_LOG_LEVEL: "debug", SEO_MCP_CRAWL_DELAY_MS: "0" });
  assert.equal(c.fetchTimeoutMs, 5_000);
  assert.equal(c.logLevel, "debug");
  assert.equal(c.crawlDelayMs, 0);
});

test("invalid integers fall back to the default instead of crashing", () => {
  const c = configWith({ SEO_MCP_FETCH_TIMEOUT_MS: "not-a-number" });
  assert.equal(c.fetchTimeoutMs, 20_000);
});

test("out-of-range integers fall back to the default", () => {
  // Below the 1000ms floor and above the 120000ms ceiling.
  assert.equal(configWith({ SEO_MCP_FETCH_TIMEOUT_MS: "5" }).fetchTimeoutMs, 20_000);
  assert.equal(configWith({ SEO_MCP_FETCH_TIMEOUT_MS: "999999" }).fetchTimeoutMs, 20_000);
});

test("invalid enum values fall back to the default", () => {
  assert.equal(configWith({ SEO_MCP_LOG_LEVEL: "chatty" }).logLevel, "info");
  assert.equal(configWith({ SEO_MCP_LOG_FORMAT: "xml" }).logFormat, "json");
});

test("booleans accept common spellings", () => {
  for (const v of ["0", "false", "no", "off"])
    assert.equal(configWith({ SEO_MCP_ALLOW_PRIVATE_HOSTS: v }).allowPrivateHosts, false, `${v} → false`);
  for (const v of ["1", "true", "yes", "on"])
    assert.equal(configWith({ SEO_MCP_ALLOW_PRIVATE_HOSTS: v }).allowPrivateHosts, true, `${v} → true`);
  // Unparseable → documented default.
  assert.equal(configWith({ SEO_MCP_ALLOW_PRIVATE_HOSTS: "maybe" }).allowPrivateHosts, true);
});

test("the Lighthouse version is pinned and only exact versions are accepted", () => {
  assert.match(config.lighthouseVersion, /^\d+\.\d+\.\d+$/, "default must be an exact version");
  assert.equal(configWith({ SEO_MCP_LIGHTHOUSE_VERSION: "12.8.2" }).lighthouseVersion, "12.8.2");
  assert.equal(configWith({ SEO_MCP_LIGHTHOUSE_VERSION: "13.0.0-beta.1" }).lighthouseVersion, "13.0.0-beta.1");
  // Ranges, tags and other npm specs would defeat the pin — fall back to the default.
  for (const bad of ["latest", "^13.0.0", "13", "github:evil/lighthouse", "13.5.0 --foo"])
    assert.equal(
      configWith({ SEO_MCP_LIGHTHOUSE_VERSION: bad }).lighthouseVersion,
      config.lighthouseVersion,
      `${bad} should be rejected`
    );
});

test("empty-string env vars are treated as unset", () => {
  assert.equal(configWith({ SEO_MCP_FETCH_TIMEOUT_MS: "" }).fetchTimeoutMs, 20_000);
});

test("SEO_MCP_STATE_DIR is resolved to an absolute path", () => {
  const c = configWith({ SEO_MCP_STATE_DIR: "./rel-state" });
  assert.ok(c.stateDir.startsWith("/"), `expected absolute, got ${c.stateDir}`);
  assert.match(c.stateDir, /rel-state$/);
});

/* ---------------- Error mapping ---------------- */

test("network error codes map to actionable messages", () => {
  const cases = [
    ["ENOTFOUND", /resolve the hostname/i],
    ["ECONNREFUSED", /refused/i],
    ["ECONNRESET", /reset/i],
    ["CERT_HAS_EXPIRED", /expired/i],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", /self-signed/i],
    ["ERR_TLS_CERT_ALTNAME_INVALID", /does not cover/i],
    ["ENOSPC", /no space/i],
  ];
  for (const [code, pattern] of cases) {
    const err = Object.assign(new Error("raw"), { code });
    assert.match(describeError(err, { url: "https://example.com" }), pattern, `${code} should be explained`);
  }
});

test("error codes nested under err.cause are also recognized (undici wraps them)", () => {
  const err = new Error("fetch failed");
  err.cause = Object.assign(new Error("dns"), { code: "ENOTFOUND" });
  assert.match(describeError(err, { url: "https://nope.invalid" }), /resolve the hostname/i);
});

test("timeouts are explained with the tunable that controls them", () => {
  const err = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  assert.match(describeError(err, { url: "https://slow.example" }), /did not respond in time/);
  assert.match(describeError(err, { url: "https://slow.example" }), /SEO_MCP_FETCH_TIMEOUT_MS/);
});

test("validation errors pass through their own message verbatim", () => {
  const err = new UrlValidationError("URL must use http:// or https://");
  assert.equal(describeError(err), "URL must use http:// or https://");
});

test("unknown errors fall back to the raw message rather than a generic string", () => {
  assert.equal(describeError(new Error("something odd")), "something odd");
});

/* ---------------- Tool result shapes ---------------- */

test("ok() produces a valid MCP content result", () => {
  const r = ok("hello");
  assert.deepEqual(r, { content: [{ type: "text", text: "hello" }] });
  assert.equal(r.isError, undefined);
});

test("toolError() sets isError so the model can see the failure", () => {
  const r = toolError("it broke");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /❌ it broke/);
});

test("guard() converts a thrown error into an isError result, not a crash", async () => {
  const handler = guard("check_thing", async () => {
    throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
  });
  const res = await handler({ url: "https://example.com" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /check_thing failed/);
  assert.match(res.content[0].text, /refused/i);
});

test("guard() passes successful results through untouched", async () => {
  const handler = guard("check_thing", async () => ok("all good"));
  const res = await handler({});
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, "all good");
});

test("guard() catches synchronous throws too", async () => {
  const handler = guard("check_thing", () => {
    throw new UrlValidationError("bad url");
  });
  const res = await handler({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /bad url/);
});
