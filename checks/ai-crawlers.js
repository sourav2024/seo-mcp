import { parseUrlOrThrow, getPage, getResource, pass, warn, fail } from "./helpers.js";

/* ---------------- AI crawlers & indexability ---------------- */
export const AI_BOTS = ["GPTBot", "ClaudeBot", "Google-Extended", "PerplexityBot", "CCBot"];

export function parseRobotsGroups(txt) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      if (key === "disallow" || key === "allow") {
        current?.rules.push({ type: key, path: val });
      }
      lastWasAgent = false;
    }
  }
  return groups;
}

export function botRobotsStatus(groups, bot) {
  const botL = bot.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && botL.includes(a)));
  const applicable = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  const rules = applicable.flatMap((g) => g.rules);
  const blanketDisallow = rules.some((r) => r.type === "disallow" && r.path === "/");
  const rootAllow = rules.some((r) => r.type === "allow" && (r.path === "/" || r.path === ""));
  return {
    viaOwnGroup: own.length > 0,
    blocked: blanketDisallow && !rootAllow,
  };
}

/**
 * @param {string} url    page URL to check
 * @param {object} [page] prefetched page, shared with the rest of a full audit
 * @param {Map}    [cache] per-audit resource cache, shared with auditRobots
 */
export async function auditAiCrawlers(url, page, cache) {
  const lines = ["## AI crawlers & indexability"];
  const parsed = parseUrlOrThrow(url, { context: "AI-crawler page URL" });
  url = parsed.href;
  const origin = parsed.origin;
  const robotsUrl = `${origin}/robots.txt`;

  // robots.txt per-bot status — same file auditRobots reads, fetched once per audit.
  let groups = [];
  const robots = await getResource(robotsUrl, cache);
  if (robots.error) {
    lines.push(warn(`Could not fetch robots.txt (${robots.error.message}) — crawlers default to allowed.`));
  } else if (!robots.ok) {
    lines.push(warn(`robots.txt returned HTTP ${robots.status} — all crawlers default to allowed.`));
  } else if (!/^\s*user-agent\s*:/im.test(robots.body)) {
    const landed = robots.finalUrl !== robotsUrl ? ` (request redirected to ${robots.finalUrl})` : "";
    lines.push(
      fail(
        `${robotsUrl} does not contain any User-agent groups${landed} — it is not a valid robots.txt, so you have no crawler directives at all. Serve a real robots.txt at this exact path.`
      )
    );
  } else {
    groups = parseRobotsGroups(robots.body);
  }
  if (groups.length) {
    for (const bot of [...AI_BOTS, "*"]) {
      const { viaOwnGroup, blocked } = botRobotsStatus(groups, bot);
      const label = bot === "*" ? "* (default)" : bot;
      if (!blocked) {
        lines.push(pass(`${label}: allowed${viaOwnGroup ? " (own rule group)" : ""}.`));
      } else if (viaOwnGroup) {
        lines.push(
          warn(
            `${label}: explicitly blocked by its own rule group — fine if intentional, but this bot won't see your content.`
          )
        );
      } else {
        lines.push(
          fail(
            `${label}: blocked by a blanket "Disallow: /" under User-agent: * with no per-bot override — ${bot === "*" ? "the whole site is uncrawlable" : `add a "User-agent: ${bot}\\nAllow: /" group if you want AI visibility`}.`
          )
        );
      }
    }
  }

  // llms.txt
  const llms = await getResource(`${origin}/llms.txt`, cache);
  if (llms.error) {
    lines.push(warn("No /llms.txt — optional, but helps AI assistants understand your site."));
  } else {
    lines.push(
      llms.ok
        ? pass(`${origin}/llms.txt exists.`)
        : warn(
            `No /llms.txt (HTTP ${llms.status}) — optional, but a concise Markdown summary of your site helps AI assistants cite you accurately.`
          )
    );
  }

  // Page-level noindex/nofollow: X-Robots-Tag header AND <meta name="robots">
  try {
    const { headers, body } = await getPage(url, page);
    const xrt = headers.get("x-robots-tag") || "";
    if (/noindex|nofollow/i.test(xrt)) {
      lines.push(
        fail(
          `X-Robots-Tag response header contains "${xrt}" — this page is being removed/hidden from search results at the HTTP level. Remove the header unless intentional.`
        )
      );
    } else {
      lines.push(pass("No noindex/nofollow in the X-Robots-Tag response header."));
    }
    const metaRobots =
      body.match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)["']/i)?.[1] ||
      body.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']robots["']/i)?.[1] ||
      "";
    if (/noindex|nofollow/i.test(metaRobots)) {
      lines.push(
        fail(
          `<meta name="robots" content="${metaRobots}"> — this page is excluded from indexing/link-following in the HTML. Remove it unless intentional.`
        )
      );
    } else {
      lines.push(pass('No noindex/nofollow in <meta name="robots">.'));
    }
  } catch (e) {
    lines.push(fail(`Could not fetch the page to check noindex/nofollow: ${e.message}`));
  }

  return lines.join("\n");
}
