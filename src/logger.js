/**
 * Structured logger for a stdio MCP server.
 *
 * CRITICAL: on stdio transport, stdout carries the JSON-RPC protocol. Writing
 * anything else there corrupts the stream and breaks the client connection, so
 * every log line goes to stderr — which MCP clients surface as server logs.
 *
 * Output is one JSON object per line (easy for clients/CI to parse), or
 * human-readable text when SEO_MCP_LOG_FORMAT=text.
 */
import { config } from "./config.js";

export const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Keys whose values are replaced with "[redacted]" before serialization. */
const SENSITIVE_KEY = /^(.*(authorization|cookie|api[-_]?key|secret|token|password|passwd|credential|session).*)$/i;

/** Query/header names that commonly carry credentials inside URLs. */
const SENSITIVE_PARAM = /^(access_token|api_key|apikey|key|token|password|secret|signature|sig|auth)$/i;

/**
 * Strip credentials from a URL so logging an audited URL can never leak them:
 * userinfo (https://user:pw@host) is dropped and sensitive query params masked.
 */
export function sanitizeUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, "[redacted]");
    }
    return u.href;
  } catch {
    return String(value);
  }
}

const MAX_DEPTH = 4;
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;

/**
 * Recursively redact sensitive fields, producing a plain acyclic structure.
 *
 * Depth-capped and cycle-aware: a logging call must never throw or hang, so a
 * repeated reference becomes "[circular]" rather than reaching JSON.stringify
 * (which would throw on a cycle) and long strings/arrays are truncated so one
 * bad payload can't produce a megabyte of log output.
 */
function redact(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) items.push(`…${value.length - MAX_ARRAY} more`);
    return items;
  }
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map || value instanceof Set) return `[${value.constructor.name} size=${value.size}]`;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) out[k] = "[redacted]";
    else if (/^(url|href|location|target)$/i.test(k) && typeof v === "string") out[k] = sanitizeUrl(v);
    else out[k] = redact(v, depth + 1, seen);
  }
  return out;
}

/** Serialize an Error without leaking a full stack in non-debug modes. */
function serializeError(err) {
  if (!(err instanceof Error)) return redact(err);
  const out = { name: err.name, message: err.message };
  if (err.code) out.code = err.code;
  if (err.cause?.code) out.cause = err.cause.code;
  if (config.logLevel === "debug" && err.stack) out.stack = err.stack;
  return out;
}

function emit(level, msg, fields = {}) {
  if (LEVELS[level] > LEVELS[config.logLevel]) return;
  const { err, ...rest } = fields;
  const data = redact(rest);
  if (err !== undefined) data.err = serializeError(err);

  let line;
  if (config.logFormat === "text") {
    const extras = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    line = `${level.toUpperCase().padEnd(5)} ${msg}${extras ? ` ${extras}` : ""}`;
  } else {
    try {
      line = JSON.stringify({
        level,
        time: new Date().toISOString(),
        name: "seo-mcp",
        msg,
        ...data,
      });
    } catch {
      // Last resort: never let a logging call throw into the caller's path.
      line = JSON.stringify({
        level,
        time: new Date().toISOString(),
        name: "seo-mcp",
        msg,
        fields: "[unserializable]",
      });
    }
  }
  // Direct write to fd 2: never console.log (stdout is the protocol channel).
  process.stderr.write(`${line}\n`);
}

export const log = {
  error: (msg, fields) => emit("error", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  debug: (msg, fields) => emit("debug", msg, fields),
  /** Millisecond timer for duration fields: const done = log.timer(); done() → 123 */
  timer() {
    const t0 = process.hrtime.bigint();
    return () => Number((process.hrtime.bigint() - t0) / 1_000_000n);
  },
};
