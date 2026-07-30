/**
 * MCP tool-result helpers.
 *
 * Per the MCP spec, a *tool execution* failure should be reported as a normal
 * result with `isError: true` — not as a JSON-RPC protocol error. That way the
 * model sees the failure text and can retry or explain it, instead of the client
 * surfacing an opaque transport error. Protocol errors are reserved for things
 * like an unknown tool name or malformed arguments (the SDK handles those).
 */
import { log } from "./logger.js";
import { UrlValidationError } from "./url-guard.js";

/** A successful tool result carrying Markdown/JSON/summary text. */
export function ok(textContent) {
  return { content: [{ type: "text", text: textContent }] };
}

/**
 * Report progress to the client, if it asked for it.
 *
 * A crawl or Lighthouse run takes minutes; without this the client shows a
 * frozen spinner with no indication the server is alive. Failure to notify is
 * never fatal — a dropped progress message must not fail the audit.
 */
export function progressReporter(extra, total) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return async () => {};
  let last = 0;
  return async (progress, message) => {
    // Progress must be monotonically increasing per the spec.
    if (progress < last) return;
    last = progress;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    } catch (err) {
      log.debug("Progress notification failed", { err });
    }
  };
}

/** Raised when the client cancels a request mid-flight. */
export class CancelledError extends Error {
  constructor() {
    super("The request was cancelled by the client.");
    this.name = "CancelledError";
  }
}

/** Throw if the client has cancelled; call between units of work. */
export function throwIfCancelled(extra) {
  if (extra?.signal?.aborted) throw new CancelledError();
}

/** A failed tool result the model can read and act on. */
export function toolError(message) {
  return { content: [{ type: "text", text: `❌ ${message}` }], isError: true };
}

/** Timeouts surface as AbortError/TimeoutError depending on the Node version. */
function isTimeout(err) {
  return err?.name === "TimeoutError" || err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

/**
 * Translate an exception into an actionable message.
 *
 * Network failures are the common case for this server, and raw Node error
 * codes ("ENOTFOUND") mean little to an end user — each maps to a plain
 * explanation plus what to do about it.
 */
export function describeError(err, { tool, url } = {}) {
  if (err instanceof UrlValidationError) return err.message;
  if (err instanceof CancelledError) return err.message;
  if (isTimeout(err))
    return `${url ? `${url} ` : ""}did not respond in time. The site may be slow or blocking automated requests — try again, or raise SEO_MCP_FETCH_TIMEOUT_MS.`;

  const code = err?.cause?.code || err?.code;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not resolve the hostname${url ? ` for ${url}` : ""}. Check the URL for typos and that the domain exists.`;
    case "ECONNREFUSED":
      return `Connection refused${url ? ` by ${url}` : ""}. Nothing is listening on that host/port — if this is a local site, confirm the dev server is running.`;
    case "ECONNRESET":
      return `The connection was reset${url ? ` by ${url}` : ""}. The site may be rate-limiting or blocking this crawler.`;
    case "ETIMEDOUT":
      return `The connection timed out${url ? ` to ${url}` : ""}.`;
    case "CERT_HAS_EXPIRED":
      return `The TLS certificate${url ? ` for ${url}` : ""} has expired — this is itself an SEO/security failure worth fixing.`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return `The TLS certificate${url ? ` for ${url}` : ""} is self-signed, so browsers and crawlers will reject it. Use a trusted certificate (Let's Encrypt is free).`;
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return `The TLS certificate chain${url ? ` for ${url}` : ""} is incomplete — the server is likely missing an intermediate certificate.`;
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `The TLS certificate${url ? ` for ${url}` : ""} does not cover this hostname.`;
    case "ENOENT":
      return `A required file or command was not found: ${err.message}`;
    case "EACCES":
    case "EPERM":
      return `Permission denied: ${err.message}`;
    case "ENOSPC":
      return "No space left on device — could not write the report.";
    case "ERR_CHILD_PROCESS_STDIO_MAXBUFFER":
      return "Lighthouse produced more output than could be buffered. Try a lighter page.";
    default:
      return err?.message || String(err);
  }
}

/**
 * Wrap a tool handler so no exception can escape into the transport.
 *
 * Any throw becomes an isError result with an actionable message; the full error
 * (with stack, at debug level) goes to the server log. This is what keeps a
 * single bad URL from killing the client's session.
 */
export function guard(toolName, handler) {
  return async (args, extra) => {
    const done = log.timer();
    try {
      const result = await handler(args, extra);
      log.info("Tool completed", { tool: toolName, ms: done() });
      return result;
    } catch (err) {
      const message = describeError(err, { tool: toolName, url: args?.url });
      // Cancellation is a normal outcome the user asked for, not a failure.
      if (err instanceof CancelledError || extra?.signal?.aborted) {
        log.info("Tool cancelled", { tool: toolName, ms: done() });
      } else {
        log.error("Tool failed", { tool: toolName, ms: done(), url: args?.url, err });
      }
      return toolError(`${toolName} failed: ${message}`);
    }
  };
}
