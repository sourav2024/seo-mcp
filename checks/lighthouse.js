import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { pass, warn, fail } from "./helpers.js";
import { assertFetchableUrl, assertResolvesPublic } from "../src/url-guard.js";
import { config } from "../src/config.js";
import { log } from "../src/logger.js";

const execFileAsync = promisify(execFile);

/** Core Web Vitals thresholds (Google's "good" / "needs improvement" cutoffs). */
const LCP_GOOD_MS = 2_500;
const CLS_GOOD = 0.1;
const CLS_POOR = 0.25;
const INP_GOOD_MS = 200;
const INP_POOR_MS = 500;
const TBT_GOOD_MS = 200;
const TBT_POOR_MS = 600;
/** Ignore opportunities below this to keep the report actionable. */
const MIN_OPPORTUNITY_MS = 100;
const MAX_OPPORTUNITIES = 5;
/** Lighthouse JSON for a heavy page can be tens of MB. */
const LIGHTHOUSE_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Lighthouse needs a real Chrome binary, and MCP servers launched from a GUI
 * client often inherit a minimal PATH. Detect both problems up front so the
 * failure is actionable instead of an opaque npx/spawn error 2 minutes in.
 */
const CHROME_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

export function findChrome() {
  if (config.chromePath && existsSync(config.chromePath)) return config.chromePath;
  return (CHROME_PATHS[process.platform] || []).find((p) => existsSync(p)) || null;
}

/**
 * Resolve the npx executable without a shell.
 *
 * On Windows, `npx` is a .cmd shim that cannot be spawned directly, and using
 * `shell: true` to work around that would pass the URL through cmd.exe — making
 * a URL like `https://x.com/?a=1&calc.exe` a command-injection vector. Spawning
 * npx.cmd via cmd.exe /c with execFile's argument array keeps arguments
 * separate from the command string.
 */
function npxCommand() {
  return process.platform === "win32"
    ? { command: process.env.COMSPEC || "cmd.exe", prefix: ["/d", "/s", "/c", "npx.cmd"] }
    : { command: "npx", prefix: [] };
}

/* ---------------- Lighthouse (Core Web Vitals) ---------------- */

/**
 * @param {string} url
 * @param {"mobile"|"desktop"} formFactor
 * @param {{ signal?: AbortSignal }} [opts] signal kills the child process when
 *   the client cancels, rather than leaving Chrome running for another minute.
 */
export async function runLighthouse(url, formFactor, { signal } = {}) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error(
      "no Chrome/Chromium binary found. Install Google Chrome, or set CHROME_PATH to an existing Chrome/Chromium/Edge binary. " +
        "All other seo-mcp checks work without Chrome — only run_lighthouse needs it."
    );
  }
  // Validate before spawning: this string becomes a child-process argument.
  const target = assertFetchableUrl(url, { context: "Lighthouse URL" }).href;
  // Chrome does its own DNS and follows redirects itself, so this is a pre-check
  // on the starting host only — see SECURITY.md.
  await assertResolvesPublic(target, { context: "Lighthouse URL" });
  const { command, prefix } = npxCommand();
  const args = [
    ...prefix,
    "-y",
    `lighthouse@${config.lighthouseVersion}`,
    target,
    "--only-categories=performance,seo",
    "--chrome-flags=--headless=new",
    "--output=json",
    "--quiet",
  ];
  if (formFactor === "desktop") args.push("--preset=desktop");

  const done = log.timer();
  log.debug("Running Lighthouse", { url: target, formFactor, chrome, version: config.lighthouseVersion });
  const { stdout } = await execFileAsync(command, args, {
    timeout: config.lighthouseTimeoutMs,
    maxBuffer: LIGHTHOUSE_MAX_BUFFER,
    // No shell: arguments stay separate from the command string.
    shell: false,
    windowsVerbatimArguments: false,
    env: { ...process.env, CHROME_PATH: chrome },
    // Terminates Chrome promptly when the client cancels the request.
    signal,
  });
  log.debug("Lighthouse finished", { ms: done() });

  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    throw new Error(
      "Lighthouse did not return valid JSON (the run may have been interrupted or Chrome failed to launch)."
    );
  }
  if (!r || typeof r !== "object" || !r.categories || !r.audits)
    throw new Error("Lighthouse returned an unexpected report shape (missing categories/audits).");
  const perf = Math.round((r.categories.performance?.score ?? 0) * 100);
  const seo = Math.round((r.categories.seo?.score ?? 0) * 100);
  const lcp = r.audits["largest-contentful-paint"]?.numericValue;
  const lcpS = lcp != null ? (lcp / 1000).toFixed(2) : "?";
  const lines = [
    `## Lighthouse (${formFactor})`,
    `Performance: ${perf}/100 · SEO: ${seo}/100`,
    lcp != null && lcp <= LCP_GOOD_MS
      ? pass(`LCP ${lcpS}s (target ≤ 2.5s).`)
      : fail(`LCP ${lcpS}s — target is ≤ 2.5s. Over ~3s you start losing visitors.`),
  ];

  // CLS (Core Web Vital): ≤ 0.1 good, ≤ 0.25 needs improvement, > 0.25 poor
  const cls = r.audits["cumulative-layout-shift"]?.numericValue;
  if (cls != null) {
    lines.push(
      cls <= CLS_GOOD
        ? pass(`CLS ${cls.toFixed(3)} (target ≤ 0.1).`)
        : cls <= CLS_POOR
          ? warn(
              `CLS ${cls.toFixed(3)} — target is ≤ 0.1. Reserve space for images/embeds (explicit width/height) and avoid injecting content above existing content.`
            )
          : fail(
              `CLS ${cls.toFixed(3)} — well above the 0.1 target. Reserve space for images/embeds (explicit width/height) and avoid layout-shifting injections.`
            )
    );
  }

  // INP (Core Web Vital): ≤ 200ms good, ≤ 500ms needs improvement, > 500ms poor.
  // Lab (navigation) runs often can't measure INP — it needs real interactions; fall back to TBT as a proxy.
  const inpAudit = r.audits["interaction-to-next-paint"];
  const inp = inpAudit?.numericValue;
  if (inp != null && inpAudit.scoreDisplayMode !== "notApplicable") {
    lines.push(
      inp <= INP_GOOD_MS
        ? pass(`INP ${Math.round(inp)}ms (target ≤ 200ms).`)
        : inp <= INP_POOR_MS
          ? warn(`INP ${Math.round(inp)}ms — target is ≤ 200ms. Break up long JS tasks and reduce main-thread work.`)
          : fail(
              `INP ${Math.round(inp)}ms — well above the 200ms target. Break up long JS tasks and reduce main-thread work.`
            )
    );
  } else {
    const tbt = r.audits["total-blocking-time"]?.numericValue;
    lines.push(
      `Note: INP needs real user interactions, which lab navigation runs can't simulate${
        tbt != null
          ? ` — TBT (lab proxy): ${Math.round(tbt)}ms (${tbt <= TBT_GOOD_MS ? "good" : tbt <= TBT_POOR_MS ? "needs improvement" : "poor"})`
          : ""
      }. Check field INP in Search Console / CrUX.`
    );
  }

  lines.push("Usual bottlenecks: slow hosting, heavy images, render-blocking CSS/JS, bloated themes/plugins.");
  const opportunities = Object.values(r.audits)
    .filter((a) => a.details?.type === "opportunity" && a.numericValue > MIN_OPPORTUNITY_MS)
    .sort((a, b) => b.numericValue - a.numericValue)
    .slice(0, MAX_OPPORTUNITIES)
    .map((a) => `- ${a.title} (~${Math.round(a.numericValue)}ms savings)`);
  if (opportunities.length) lines.push("Top opportunities:", ...opportunities);
  return lines.join("\n");
}
