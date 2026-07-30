/**
 * Tests for CLI behavior — the first thing a user touches when a client fails to
 * connect, and the one surface where "silently hangs" is the worst outcome.
 */
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const SERVER = `${ROOT}server.js`;

/** Run the CLI and capture stdout/stderr/exit code without throwing. */
async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SERVER, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("--version prints the package version and exits 0", async () => {
  const { code, stdout } = await run(["--version"]);
  const { version } = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8"));
  assert.equal(code, 0);
  assert.equal(stdout.trim(), version);
});

test("-v is accepted as a short form", async () => {
  const { code, stdout } = await run(["-v"]);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("--help documents usage, tools, and configuration", async () => {
  const { code, stdout } = await run(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /USAGE/);
  assert.match(stdout, /TOOLS \(13\)/, "the tool count should be derived and current");
  assert.match(stdout, /seo_full_audit/);
  assert.match(stdout, /run_lighthouse/);
  assert.match(stdout, /SEO_MCP_LOG_LEVEL/);
  // Users mistake this for an interactive CLI; the help must correct that.
  assert.match(stdout, /not an interactive CLI/);
});

test("--help lists every registered tool", async () => {
  const { stdout } = await run(["--help"]);
  const tools = [
    "seo_full_audit",
    "crawl_audit",
    "check_rendering",
    "check_https",
    "check_url_structure",
    "check_page_essentials",
    "check_caching",
    "check_sitemap",
    "check_robots",
    "check_keyword_placement",
    "check_structured_data",
    "check_ai_crawlers",
    "run_lighthouse",
  ];
  for (const t of tools) assert.match(stdout, new RegExp(t), `--help should mention ${t}`);
});

/* ---------------- Unknown arguments ---------------- */

test("an unknown flag exits non-zero instead of starting the server", async () => {
  // Previously this started the stdio server, so a typo looked like a hang.
  const { code, stderr } = await run(["--bogus"]);
  assert.equal(code, 2, "should exit 2, not hang or exit 0");
  assert.match(stderr, /unrecognized argument/);
  assert.match(stderr, /--help/, "should point the user at --help");
});

test("a plausible-but-wrong flag is rejected rather than silently ignored", async () => {
  // --transport=http is a natural guess; accepting it silently would give the
  // user stdio while they believed they had HTTP.
  const { code, stderr } = await run(["--transport=http"]);
  assert.equal(code, 2);
  assert.match(stderr, /unrecognized argument/);
});

test("multiple unknown arguments are all reported", async () => {
  const { code, stderr } = await run(["--foo", "--bar"]);
  assert.equal(code, 2);
  assert.match(stderr, /--foo --bar/);
  assert.match(stderr, /arguments:/, "should pluralize for more than one");
});

test("a bare positional argument is rejected", async () => {
  // "seo-mcp https://example.com" reads as a CLI invocation but isn't one.
  const { code, stderr } = await run(["https://example.com"]);
  assert.equal(code, 2);
  assert.match(stderr, /unrecognized argument/);
});

test("nothing is written to stdout when arguments are rejected", async () => {
  // stdout carries the MCP protocol; diagnostics must never go there.
  const { stdout } = await run(["--bogus"]);
  assert.equal(stdout, "");
});
