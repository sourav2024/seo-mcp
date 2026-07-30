/**
 * Tests for the logger — specifically the two properties that matter most:
 * nothing sensitive escapes into logs, and nothing is ever written to stdout
 * (which carries the MCP JSON-RPC protocol).
 */
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { log, sanitizeUrl, LEVELS } from "../src/logger.js";

/** Capture stderr/stdout writes made during fn(). */
function capture(fn) {
  const err = [];
  const out = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  try {
    fn();
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  return { stderr: err.join(""), stdout: out.join("") };
}

test("logs go to stderr and never to stdout (stdout is the MCP channel)", () => {
  const { stderr, stdout } = capture(() => {
    log.error("boom");
    log.warn("careful");
    log.info("hello");
  });
  assert.equal(stdout, "", "nothing may be written to stdout");
  assert.match(stderr, /hello/);
});

test("output is one parseable JSON object per line", () => {
  const { stderr } = capture(() => log.info("audit finished", { url: "https://example.com", checks: 12 }));
  const lines = stderr.trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "audit finished");
  assert.equal(parsed.name, "seo-mcp");
  assert.equal(parsed.checks, 12);
  assert.ok(Date.parse(parsed.time), "time should be a valid timestamp");
});

test("sensitive field names are redacted", () => {
  const { stderr } = capture(() =>
    log.info("request", {
      authorization: "Bearer abc123",
      apiKey: "sk-secret",
      api_key: "sk-secret2",
      password: "hunter2",
      sessionToken: "tok",
      cookie: "sid=1",
      safe: "keep-me",
    })
  );
  assert.doesNotMatch(stderr, /abc123|sk-secret|hunter2|sid=1/, "no secret values may appear");
  assert.match(stderr, /keep-me/, "non-sensitive fields are preserved");
  const parsed = JSON.parse(stderr.trim());
  assert.equal(parsed.authorization, "[redacted]");
  assert.equal(parsed.password, "[redacted]");
});

test("credentials embedded in URLs are stripped", () => {
  assert.equal(sanitizeUrl("https://user:pw@example.com/x"), "https://example.com/x");
  assert.match(sanitizeUrl("https://example.com/?api_key=secret123"), /api_key=%5Bredacted%5D|api_key=\[redacted\]/);
  assert.doesNotMatch(sanitizeUrl("https://example.com/?access_token=abc"), /abc/);
  // Non-sensitive params are left intact.
  assert.match(sanitizeUrl("https://example.com/?page=2"), /page=2/);
});

test("url-ish fields are sanitized inside log payloads", () => {
  const { stderr } = capture(() => log.info("fetched", { url: "https://u:p@example.com/?token=xyz" }));
  assert.doesNotMatch(stderr, /xyz/);
  assert.doesNotMatch(stderr, /u:p@/);
});

test("sanitizeUrl passes through non-URL strings unchanged", () => {
  assert.equal(sanitizeUrl("not a url"), "not a url");
  assert.equal(sanitizeUrl(""), "");
});

test("level filtering suppresses messages below the configured level", () => {
  // Default level is "info", so debug must not be emitted.
  const { stderr } = capture(() => log.debug("verbose detail"));
  assert.equal(stderr, "", "debug should be filtered at info level");
  assert.ok(LEVELS.debug > LEVELS.info);
});

test("errors serialize to name/message/code without a stack at default level", () => {
  const err = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
  const { stderr } = capture(() => log.error("fetch failed", { err }));
  const parsed = JSON.parse(stderr.trim());
  assert.equal(parsed.err.message, "connect failed");
  assert.equal(parsed.err.code, "ECONNREFUSED");
  assert.equal(parsed.err.stack, undefined, "no stack at info level");
});

test("long strings are truncated so one log line cannot blow up", () => {
  const { stderr } = capture(() => log.info("big", { blob: "x".repeat(10_000) }));
  assert.ok(stderr.length < 4_000, `line should be truncated, got ${stderr.length}`);
  assert.match(stderr, /…/);
});

test("cyclic objects do not throw or hang", () => {
  const a = { name: "a" };
  a.self = a;
  assert.doesNotThrow(() => capture(() => log.info("cycle", { a })));
});

test("timer returns a non-negative millisecond duration", () => {
  const done = log.timer();
  const ms = done();
  assert.equal(typeof ms, "number");
  assert.ok(ms >= 0);
});
