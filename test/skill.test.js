/**
 * Keeps the agent skill in skill/technical-seo-audit/ honest against the server
 * it drives: pinned versions match this release, every tool it names exists,
 * and the SKILL.md frontmatter satisfies the Agent Skills format. Offline.
 */
import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skill", "technical-seo-audit");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const skillMd = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");

/** Every text file in the skill, as [relativePath, contents]. */
const skillFiles = readdirSync(skillDir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => {
    const full = path.join(d.parentPath ?? d.path, d.name);
    return [path.relative(skillDir, full), readFileSync(full, "utf8")];
  });

test("SKILL.md frontmatter is valid", () => {
  const fm = skillMd.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  assert.ok(fm, "SKILL.md must start with YAML frontmatter");
  const name = fm.match(/^name: (.+)$/m)?.[1];
  const description = fm.match(/^description: "(.+)"$/m)?.[1];
  assert.equal(name, "technical-seo-audit", "name must match the skill's folder name");
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(description && description.length <= 1024, "description is required, quoted, and at most 1024 chars");
  // Unquoted YAML values may not contain ": " — it silently breaks parsing.
  for (const line of fm.split("\n").filter((l) => /^[a-z-]+: [^"]/.test(l)))
    assert.doesNotMatch(line.replace(/^[a-z-]+: /, ""), /: /, `quote this frontmatter value: ${line.slice(0, 60)}`);
});

test("every pinned package version in the skill matches package.json", () => {
  for (const [file, text] of skillFiles) {
    for (const m of text.matchAll(/technical-seo-mcp@([0-9][^\s"'`]*)/g))
      assert.equal(m[1], pkg.version, `${file} pins technical-seo-mcp@${m[1]}, expected ${pkg.version}`);
  }
  assert.match(skillMd, new RegExp(`version: "${pkg.version.replace(/\./g, "\\.")}"`));
});

test("every tool the skill names is registered by the server", () => {
  const server = readFileSync(path.join(root, "server.js"), "utf8");
  const registered = new Set([...server.matchAll(/\["([a-z_]+)", "/g)].map((m) => m[1]));
  assert.ok(registered.size >= 14, "could not read TOOL_SUMMARY from server.js");
  for (const [file, text] of skillFiles) {
    for (const m of text.matchAll(/`((?:seo|crawl|check|run)_[a-z_]+)`/g))
      assert.ok(registered.has(m[1]), `${file} mentions unknown tool ${m[1]}`);
  }
});

test("config templates parse", () => {
  for (const [file, text] of skillFiles.filter(([f]) => f.endsWith(".json")))
    assert.doesNotThrow(() => JSON.parse(text), file);
});
