/**
 * Centralized, validated configuration.
 *
 * Every tunable lives here so there are no magic numbers scattered through the
 * checks, and every environment variable is validated once at startup. Invalid
 * values fall back to the documented default with a warning rather than
 * crashing the server — a typo in an env var should never make the tool
 * unusable, and MCP clients often make it hard to see a startup crash.
 *
 * See .env.example for the full documented list.
 */
import os from "node:os";
import path from "node:path";

/** Warnings collected during parsing; flushed by initConfig() once logging exists. */
const warnings = [];

function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    warnings.push(`${name}="${raw}" is not an integer in [${min}, ${max}] — using default ${fallback}.`);
    return fallback;
  }
  return n;
}

function envEnum(name, fallback, allowed) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = String(raw).toLowerCase();
  if (!allowed.includes(v)) {
    warnings.push(`${name}="${raw}" must be one of ${allowed.join("|")} — using default "${fallback}".`);
    return fallback;
  }
  return v;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = String(raw).toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  warnings.push(`${name}="${raw}" is not a boolean — using default ${fallback}.`);
  return fallback;
}

/** Per-user state directory, following XDG on Linux and the OS convention elsewhere. */
function defaultStateDir() {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, "seo-mcp");
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "seo-mcp");
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "seo-mcp");
  return path.join(home, ".local", "state", "seo-mcp");
}

export const config = Object.freeze({
  /* ---- Logging ---- */
  logLevel: envEnum("SEO_MCP_LOG_LEVEL", "info", ["silent", "error", "warn", "info", "debug"]),
  logFormat: envEnum("SEO_MCP_LOG_FORMAT", "json", ["json", "text"]),

  /* ---- Network ---- */
  /** Per-request timeout for page fetches. */
  fetchTimeoutMs: envInt("SEO_MCP_FETCH_TIMEOUT_MS", 20_000, { min: 1_000, max: 120_000 }),
  /** Shorter timeout for the HTTPS/redirect probes, which should fail fast. */
  probeTimeoutMs: envInt("SEO_MCP_PROBE_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 }),
  /** Hard cap on bytes read from any response body (audits only inspect markup). */
  maxBodyBytes: envInt("SEO_MCP_MAX_BODY_BYTES", 10 * 1024 * 1024, { min: 64 * 1024, max: 256 * 1024 * 1024 }),
  /** Max redirect hops followed when recording a redirect chain. */
  maxRedirectHops: envInt("SEO_MCP_MAX_REDIRECT_HOPS", 5, { min: 1, max: 20 }),

  /* ---- Crawling ---- */
  /** Politeness delay between crawled pages. */
  crawlDelayMs: envInt("SEO_MCP_CRAWL_DELAY_MS", 500, { min: 0, max: 60_000 }),
  /** Upper bound on max_pages, regardless of what a caller requests. */
  crawlMaxPagesLimit: envInt("SEO_MCP_CRAWL_MAX_PAGES", 100, { min: 1, max: 1_000 }),
  /** How many concurrent page fetches a crawl may run. */
  crawlConcurrency: envInt("SEO_MCP_CRAWL_CONCURRENCY", 1, { min: 1, max: 8 }),

  /* ---- Lighthouse ---- */
  lighthouseTimeoutMs: envInt("SEO_MCP_LIGHTHOUSE_TIMEOUT_MS", 180_000, { min: 30_000, max: 600_000 }),
  /** Explicit Chrome binary; auto-detected when unset. */
  chromePath: process.env.CHROME_PATH || null,

  /* ---- Storage ---- */
  stateDir: process.env.SEO_MCP_STATE_DIR ? path.resolve(process.env.SEO_MCP_STATE_DIR) : defaultStateDir(),

  /* ---- Safety ---- */
  /**
   * Allow auditing private/loopback/link-local addresses. Default true because
   * auditing localhost:3000 and internal staging hosts is a core local use case;
   * set false when exposing the server to input you do not control.
   */
  allowPrivateHosts: envBool("SEO_MCP_ALLOW_PRIVATE_HOSTS", true),
});

/** Directory holding per-target baseline files. */
export const baselineDir = () => path.join(config.stateDir, "baselines");

/**
 * Flush any config warnings through the logger. Called once at startup, after
 * the logger is available (config must not import the logger — circular).
 */
export function initConfig(log) {
  for (const w of warnings) log.warn(`Invalid configuration: ${w}`);
  log.debug("Configuration loaded", {
    logLevel: config.logLevel,
    fetchTimeoutMs: config.fetchTimeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    crawlDelayMs: config.crawlDelayMs,
    crawlConcurrency: config.crawlConcurrency,
    stateDir: config.stateDir,
    allowPrivateHosts: config.allowPrivateHosts,
    chromePath: config.chromePath ?? "(auto-detect)",
  });
  return config;
}

/** Exposed for tests: the warnings produced while parsing env vars. */
export const configWarnings = () => [...warnings];
