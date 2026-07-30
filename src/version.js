/**
 * Single source of truth for the version, read from package.json at startup so
 * it can never drift from what npm published. Falls back to "0.0.0-dev" if the
 * manifest is unreadable (e.g. an odd bundling setup) rather than crashing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function readManifest() {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return {};
  }
}

const manifest = readManifest();

export const VERSION = typeof manifest.version === "string" && manifest.version ? manifest.version : "0.0.0-dev";
export const HOMEPAGE = "https://github.com/sourav2024/seo-mcp";

/**
 * The MCP server identity reported during initialize. Deliberately distinct
 * from the npm package name: clients display this, and "technical-seo" reads
 * better in a tool list than "technical-seo-mcp".
 */
export const SERVER_NAME = "technical-seo";
