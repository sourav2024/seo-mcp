/**
 * Test isolation: clear ambient SEO_MCP_* variables before any module reads them.
 *
 * `src/config.js` parses the environment once at import time, so a contributor
 * (or CI job) that happens to export SEO_MCP_LOG_LEVEL would otherwise change
 * what the default-behavior tests observe. Imported first by every test file.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SEO_MCP_")) delete process.env[key];
}
