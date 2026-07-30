#!/usr/bin/env node
/**
 * Fail the build if an unfilled placeholder would ship.
 *
 * A funding link pointing at a page nobody owns is worse than no link at all,
 * and a published README is hard to un-publish. This runs in `npm run verify`
 * and via prepublishOnly, so the placeholder cannot reach npm unnoticed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each entry: the token to look for, the files to scan, and how to fix it. */
const PLACEHOLDERS = [
  {
    token: "BMC-USERNAME",
    files: ["package.json", "README.md", ".github/FUNDING.yml"],
    fix: "Replace with your Buy Me a Coffee username (the last segment of buymeacoffee.com/<username>), or remove the funding link entirely if you would rather not accept support.",
  },
  {
    token: "<OWNER>",
    files: ["package.json", "README.md", "server.json"],
    fix: "Replace with the GitHub owner/organization name.",
  },
];

let failures = 0;

for (const { token, files, fix } of PLACEHOLDERS) {
  for (const file of files) {
    let content;
    try {
      content = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue; // an optional file (e.g. FUNDING.yml) may legitimately be absent
    }
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (!line.includes(token)) return;
      failures++;
      process.stderr.write(`${file}:${i + 1}  unfilled placeholder "${token}"\n  → ${fix}\n`);
    });
  }
}

if (failures > 0) {
  process.stderr.write(
    `\n${failures} unfilled placeholder${failures > 1 ? "s" : ""} found. ` +
      `Fix them (or delete the lines) before publishing.\n`
  );
  process.exit(1);
}

process.stdout.write("No unfilled placeholders.\n");
