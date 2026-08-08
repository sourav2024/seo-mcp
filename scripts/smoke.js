#!/usr/bin/env node
/**
 * Smoke test: drive the real MCP wire protocol over stdio.
 *
 * Unit tests import the check functions directly, so they never prove the
 * server actually speaks MCP — that it handshakes, advertises its tools, and
 * returns a well-formed result. This spawns the server as a client would and
 * asserts on the JSON-RPC traffic. No network access required.
 *
 * Run with: npm run smoke
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 20_000;

const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  // Quiet logs so stderr only shows genuine problems.
  env: { ...process.env, SEO_MCP_LOG_LEVEL: "error" },
});

const pending = new Map();
let buffer = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  // JSON-RPC over stdio is newline-delimited.
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`Server wrote non-JSON to stdout (this corrupts the protocol):\n${line}`);
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});
child.stderr.on("data", (c) => (stderr += c));

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${method}"`)), TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function fail(message) {
  process.stderr.write(`\n✖ ${message}\n`);
  if (stderr) process.stderr.write(`\n--- server stderr ---\n${stderr}\n`);
  child.kill();
  process.exit(1);
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(name);
    process.stdout.write(`✓ ${name}\n`);
  } catch (err) {
    fail(`${name}\n  ${err.message}`);
  }
}

try {
  /* ---- 1. Handshake ---- */
  const init = await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  check("initialize returns a result", () => {
    assert.ok(init.result, `expected result, got ${JSON.stringify(init)}`);
    assert.ok(init.result.serverInfo, "missing serverInfo");
    assert.equal(init.result.serverInfo.name, "technical-seo");
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/, "version should be semver");
  });
  check("server advertises the tools capability", () => {
    assert.ok(init.result.capabilities?.tools, "tools capability not advertised");
  });
  notify("notifications/initialized");

  /* ---- 2. Tool listing ---- */
  const list = await request("tools/list");
  const tools = list.result?.tools ?? [];
  check("tools/list returns all 14 tools", () => {
    assert.equal(tools.length, 14, `expected 14 tools, got ${tools.length}`);
  });
  check("every tool has a name, description, and input schema", () => {
    for (const t of tools) {
      assert.ok(t.name, "tool missing name");
      assert.ok(t.description?.length > 40, `${t.name}: description too short to guide a model`);
      assert.equal(t.inputSchema?.type, "object", `${t.name}: inputSchema must be an object schema`);
    }
  });
  check("tool names are snake_case and unique", () => {
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool names");
    for (const n of names) assert.match(n, /^[a-z][a-z0-9_]*$/, `${n}: should be snake_case`);
  });
  check("report tools expose the html output mode", () => {
    const full = tools.find((t) => t.name === "seo_full_audit");
    assert.deepEqual(full.inputSchema.properties.output.enum, ["markdown", "json", "html"]);
    assert.ok(full.inputSchema.properties.output_path, "output_path should be available");
  });
  check("tools declare read-only annotations", () => {
    const full = tools.find((t) => t.name === "seo_full_audit");
    assert.equal(full.annotations?.readOnlyHint, true, "audits are read-only and should say so");
  });

  /* ---- 3. Offline tool call (no network needed) ---- */
  const call = await request("tools/call", {
    name: "check_url_structure",
    arguments: { urls: ["https://example.com/Some_Ugly_URL?id=4582"] },
  });
  check("tools/call returns text content", () => {
    assert.ok(call.result, `expected result, got ${JSON.stringify(call).slice(0, 300)}`);
    assert.equal(call.result.content[0].type, "text");
    assert.ok(call.result.content[0].text.length > 0, "empty report");
  });
  check("the offline check flags known URL problems", () => {
    const body = call.result.content[0].text;
    assert.match(body, /underscore/i, "should flag underscores");
    assert.match(body, /[✅⚠️❌]/u, "should include severity markers");
  });

  /* ---- 4. Error handling: invalid input must not crash the server ---- */
  const bad = await request("tools/call", {
    name: "check_rendering",
    arguments: { url: "file:///etc/passwd" },
  });
  check("a non-HTTP scheme is rejected as an isError result, not a crash", () => {
    assert.ok(bad.result, `expected a result, got ${JSON.stringify(bad).slice(0, 300)}`);
    assert.equal(bad.result.isError, true, "should be flagged isError so the model can react");
    assert.match(bad.result.content[0].text, /http:\/\/ or https:\/\//);
  });

  const unknown = await request("tools/call", { name: "no_such_tool", arguments: {} });
  check("an unknown tool name produces a protocol error", () => {
    assert.ok(unknown.error || unknown.result?.isError, "should report an error somehow");
  });

  /* ---- 5. Progress notifications ---- */
  const withProgress = await request("tools/call", {
    name: "check_url_structure",
    arguments: { urls: ["https://example.com/ok"] },
    _meta: { progressToken: "smoke-1" },
  });
  check("a request carrying a progressToken still succeeds", () => {
    assert.ok(withProgress.result, "should return a result");
    assert.notEqual(withProgress.result.isError, true);
  });

  /* ---- 6. Malformed input is rejected, not crashed on ---- */
  const badArgs = await request("tools/call", { name: "check_url_structure", arguments: { urls: [] } });
  check("schema violations are reported as errors", () => {
    assert.ok(badArgs.error || badArgs.result?.isError, "an empty urls array must be rejected");
  });

  const unparsable = await request("tools/call", {
    name: "check_url_structure",
    arguments: { urls: ["https://good.example", "http://[", "https://also-good.example"] },
  });
  check("one malformed URL does not discard the other results", () => {
    assert.ok(unparsable.result, `expected a result, got ${JSON.stringify(unparsable).slice(0, 200)}`);
    const body = unparsable.result.content[0].text;
    assert.match(body, /not a parsable URL/, "the bad URL should be its own failure line");
    assert.match(body, /good\.example/, "the valid URLs must still be reported");
    assert.match(body, /also-good\.example/);
  });

  /* ---- 7. Still alive after errors ---- */
  const list2 = await request("tools/list");
  check("server is still responsive after handling errors", () => {
    assert.equal(list2.result?.tools?.length, tools.length);
  });

  process.stdout.write(`\n${checks.length} smoke checks passed.\n`);
  child.kill();
  process.exit(0);
} catch (err) {
  fail(err.message);
}
