import { UA, parseUrlOrThrow, pass, warn, fail } from "./helpers.js";
import { config } from "../src/config.js";
import { assertResolvesPublic } from "../src/url-guard.js";

/* ---------------- HTTPS / SSL ---------------- */

/**
 * Classify how a plain-http URL responds — exported separately so the
 * redirect logic is testable against a local fixture server (no TLS needed).
 */
export async function httpRedirectLine(httpUrl) {
  await assertResolvesPublic(httpUrl);
  const res = await fetch(httpUrl, {
    headers: { "User-Agent": UA },
    redirect: "manual",
    signal: AbortSignal.timeout(config.probeTimeoutMs),
  });
  // Only the status and Location matter — release the socket rather than leaking it.
  await res.body?.cancel?.().catch(() => {});
  const loc = res.headers.get("location") || "";
  if ([301, 308].includes(res.status) && loc.startsWith("https://")) {
    return pass(`http:// 301/308-redirects to https:// (${loc}).`);
  }
  if ([302, 307].includes(res.status) && loc.startsWith("https://")) {
    return warn(
      `http:// redirects to https:// but with a temporary ${res.status} — use a permanent 301 to preserve link equity.`
    );
  }
  return fail(`http:// returned ${res.status} without redirecting to https:// — add a 301 redirect.`);
}

/**
 * @param {string} url    site URL to check
 * @param {object} [page] prefetched page. When the audited URL is already https://,
 *   a successful fetch is itself proof the certificate validated, so the probe is
 *   skipped entirely rather than re-requesting the page.
 */
export async function auditHttps(url, page) {
  const lines = ["## HTTPS / SSL"];
  const u = parseUrlOrThrow(url, { context: "HTTPS site URL" });

  if (page && u.protocol === "https:" && page.status > 0) {
    lines.push(pass(`https:// serves with a valid certificate (HTTP ${page.status}).`));
  } else {
    try {
      // HEAD: we only need the handshake to succeed, not the body.
      await assertResolvesPublic(u.href);
      const res = await fetch(`https://${u.host}${u.pathname}`, {
        method: "HEAD",
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(config.probeTimeoutMs),
      });
      await res.body?.cancel?.().catch(() => {});
      lines.push(pass(`https:// serves with a valid certificate (HTTP ${res.status}).`));
    } catch (e) {
      lines.push(
        fail(
          `https:// failed: ${e.cause?.code || e.message}. A valid SSL cert is non-negotiable (Let's Encrypt is free).`
        )
      );
      return lines.join("\n");
    }
  }
  try {
    lines.push(await httpRedirectLine(`http://${u.host}${u.pathname}`));
  } catch {
    lines.push(warn(`http:// not reachable (port 80 may be closed) — fine as long as no links point to http://.`));
  }
  return lines.join("\n");
}
