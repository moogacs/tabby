/* global injectedClassifyPage — defined in classify.js (load before popup.js). */

/** Host access is optional: only needed to inject metadata classification into http(s) tabs. */
const OPTIONAL_HOST_ORIGINS = ["http://*/*", "https://*/*"];

/**
 * @returns {Promise<boolean>} Whether user has granted optional http(s) access for scripting.
 */
async function hasOptionalHostPermission() {
  return chrome.permissions.contains({ origins: OPTIONAL_HOST_ORIGINS });
}

/**
 * Prompts once per click (user gesture) for optional broad host access. If denied, metadata
 * classification falls back to URL-only signals.
 * @returns {Promise<boolean>}
 */
async function requestOptionalHostPermission() {
  if (await hasOptionalHostPermission()) return true;
  try {
    return await chrome.permissions.request({ origins: OPTIONAL_HOST_ORIGINS });
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @returns {string}
 */
function tabKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    let out = u.href;
    if (out.endsWith("/") && u.pathname !== "/") {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return url;
  }
}

/**
 * Tabs we count for analytics and dedupe: has id + URL, excludes chrome:// internals.
 * Matches {@link partitionDuplicates} counting.
 * @returns {Promise<chrome.tabs.Tab[]>}
 */
async function getNormalTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.id != null && t.url && !t.url.startsWith("chrome://"));
}

/**
 * @param {chrome.tabs.Tab[]} tabs
 * @returns {{
 *   keep: chrome.tabs.Tab[];
 *   close: chrome.tabs.Tab[];
 *   analytics: {
 *     totalTabs: number;
 *     uniqueUrls: number;
 *     duplicateTabs: number;
 *     duplicateGroups: number;
 *   };
 * }}
 */
function partitionDuplicates(tabs) {
  const byKey = new Map();
  let totalTabs = 0;
  for (const t of tabs) {
    if (!t.id || !t.url) continue;
    totalTabs++;
    const k = tabKey(t.url);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const keep = [];
  const close = [];
  let duplicateGroups = 0;
  for (const group of byKey.values()) {
    if (group.length > 1) duplicateGroups++;
    group.sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return (a.index ?? 0) - (b.index ?? 0);
    });
    keep.push(group[0]);
    for (let i = 1; i < group.length; i++) close.push(group[i]);
  }
  const analytics = {
    totalTabs,
    uniqueUrls: byKey.size,
    duplicateTabs: close.length,
    duplicateGroups,
  };
  return { keep, close, analytics };
}

/**
 * @param {HTMLElement} root
 * @param {{ totalTabs: number; uniqueUrls: number; duplicateTabs: number; duplicateGroups: number }} a
 */
function renderAnalytics(root, a) {
  root.querySelector("[data-stat='totalTabs']").textContent = String(a.totalTabs);
  root.querySelector("[data-stat='uniqueUrls']").textContent = String(a.uniqueUrls);
  root.querySelector("[data-stat='duplicateTabs']").textContent = String(a.duplicateTabs);
  root.querySelector("[data-stat='duplicateGroups']").textContent = String(a.duplicateGroups);
}

/**
 * @param {string} label
 * @param {{ totalTabs: number; uniqueUrls: number; duplicateTabs: number; duplicateGroups: number }} a
 * @param {{ closed?: number; exported?: number }} [extra]
 */
function logAnalytics(label, a, extra) {
  const payload = { ...a, ...extra };
  console.log(`[Tabby] ${label}`, payload);
}

/**
 * @param {string[]} lines
 */
function downloadTxt(lines) {
  const text = lines.join("\n") + (lines.length ? "\n" : "");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tabby-tab-links-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function setStatus(el, message, isError) {
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}

/** @param {chrome.tabs.Tab} tab */
function isOrganizableTab(tab) {
  return !!(tab.id && tab.url && !tab.pinned && !tab.url.startsWith("chrome://"));
}

/* Limits + splitOrganizeGroupsIntoBatches from limits.js */

/**
 * @param {string} categoryLabel
 * @param {number[]} tabIds
 * @param {number} maxPerWindow
 * @returns {{ name: string; tabIds: number[] }[]}
 */
function splitCategoryIntoWindows(categoryLabel, tabIds, maxPerWindow) {
  if (tabIds.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < tabIds.length; i += maxPerWindow) {
    chunks.push(tabIds.slice(i, i + maxPerWindow));
  }
  if (chunks.length === 1) {
    return [{ name: categoryLabel, tabIds: chunks[0] }];
  }
  return chunks.map((ids, idx) => ({
    name: `${categoryLabel} (${idx + 1}/${chunks.length})`,
    tabIds: ids,
  }));
}

/** Keep labels in sync with classify.js `C` */
const CAT = {
  DEV: "Dev & docs",
  SOCIAL: "Social & community",
  VIDEO: "Video & streaming",
  NEWS: "News & blogs",
  SHOP: "Shopping & commerce",
  WORK: "Work & productivity",
  LEARN: "Reference & learning",
  FUN: "Entertainment",
  OTHER: "Other",
};

const TIE_BREAK = [
  CAT.DEV,
  CAT.SHOP,
  CAT.VIDEO,
  CAT.NEWS,
  CAT.WORK,
  CAT.SOCIAL,
  CAT.LEARN,
  CAT.FUN,
  CAT.OTHER,
];

/**
 * Score categories from URL alone (no DOM). Used for SPAs, failed inject, discarded tabs.
 * @param {string} urlStr
 * @returns {Record<string, number>}
 */
function urlClassificationScores(urlStr) {
  /** @type {Record<string, number>} */
  const s = {};
  const add = (cat, w) => {
    s[cat] = (s[cat] || 0) + w;
  };

  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return s;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return s;

  const host = (u.hostname || "").toLowerCase();
  const path = `${u.pathname || ""}${u.search || ""}`.toLowerCase();
  const full = `${host} ${path}`;

  const exactHost = {
    "mail.google.com": CAT.WORK,
    "drive.google.com": CAT.WORK,
    "docs.google.com": CAT.WORK,
    "calendar.google.com": CAT.WORK,
    "meet.google.com": CAT.WORK,
    "www.google.com": CAT.LEARN,
    "google.com": CAT.LEARN,
    "scholar.google.com": CAT.LEARN,
    "web.whatsapp.com": CAT.SOCIAL,
    "open.spotify.com": CAT.FUN,
    "music.apple.com": CAT.FUN,
    "www.notion.so": CAT.WORK,
    "notion.so": CAT.WORK,
    "linear.app": CAT.WORK,
    "app.slack.com": CAT.WORK,
    "slack.com": CAT.WORK,
    "teams.microsoft.com": CAT.WORK,
    "outlook.live.com": CAT.WORK,
    "outlook.office.com": CAT.WORK,
    "mail.yahoo.com": CAT.WORK,
    "console.aws.amazon.com": CAT.DEV,
    "portal.azure.com": CAT.WORK,
    "github.com": CAT.DEV,
    "gist.github.com": CAT.DEV,
    "gitlab.com": CAT.DEV,
    "bitbucket.org": CAT.DEV,
    "sourcegraph.com": CAT.DEV,
    "vercel.com": CAT.DEV,
    "netlify.com": CAT.DEV,
    "readthedocs.io": CAT.DEV,
    "developer.mozilla.org": CAT.DEV,
    "learn.microsoft.com": CAT.DEV,
    "stackoverflow.com": CAT.DEV,
    "stackexchange.com": CAT.DEV,
    "serverfault.com": CAT.DEV,
    "superuser.com": CAT.DEV,
    "askubuntu.com": CAT.DEV,
    "npmjs.com": CAT.DEV,
    "www.npmjs.com": CAT.DEV,
    "pypi.org": CAT.DEV,
    "crates.io": CAT.DEV,
    "pkg.go.dev": CAT.DEV,
    "rubygems.org": CAT.DEV,
    "news.ycombinator.com": CAT.NEWS,
    "www.reddit.com": CAT.SOCIAL,
    "old.reddit.com": CAT.SOCIAL,
    "twitter.com": CAT.SOCIAL,
    "x.com": CAT.SOCIAL,
    "bsky.app": CAT.SOCIAL,
    "www.linkedin.com": CAT.SOCIAL,
    "www.facebook.com": CAT.SOCIAL,
    "www.instagram.com": CAT.SOCIAL,
    "www.tiktok.com": CAT.SOCIAL,
    "discord.com": CAT.SOCIAL,
    "www.pinterest.com": CAT.SOCIAL,
    "www.youtube.com": CAT.VIDEO,
    "youtu.be": CAT.VIDEO,
    "www.twitch.tv": CAT.VIDEO,
    "vimeo.com": CAT.VIDEO,
    "www.netflix.com": CAT.FUN,
    "www.amazon.com": CAT.SHOP,
    "www.amazon.co.uk": CAT.SHOP,
    "www.amazon.de": CAT.SHOP,
    "www.ebay.com": CAT.SHOP,
    "www.etsy.com": CAT.SHOP,
    "www.walmart.com": CAT.SHOP,
    "www.target.com": CAT.SHOP,
    "www.bestbuy.com": CAT.SHOP,
    "www.wikipedia.org": CAT.LEARN,
    "en.wikipedia.org": CAT.LEARN,
    "medium.com": CAT.NEWS,
    "www.bbc.com": CAT.NEWS,
    "www.bbc.co.uk": CAT.NEWS,
    "www.cnn.com": CAT.NEWS,
    "www.nytimes.com": CAT.NEWS,
    "www.theguardian.com": CAT.NEWS,
    "www.washingtonpost.com": CAT.NEWS,
    "www.reuters.com": CAT.NEWS,
    "www.bloomberg.com": CAT.NEWS,
    "www.wsj.com": CAT.NEWS,
    "www.ft.com": CAT.NEWS,
    "www.theverge.com": CAT.NEWS,
    "www.wired.com": CAT.NEWS,
    "arstechnica.com": CAT.NEWS,
    "techcrunch.com": CAT.NEWS,
    "www.figma.com": CAT.WORK,
    "www.canva.com": CAT.WORK,
    "app.asana.com": CAT.WORK,
    "asana.com": CAT.WORK,
    "trello.com": CAT.WORK,
    "www.atlassian.com": CAT.WORK,
    "www.notion.site": CAT.WORK,
    "substack.com": CAT.NEWS,
    "www.substack.com": CAT.NEWS,
    "dev.to": CAT.DEV,
    "www.producthunt.com": CAT.NEWS,
    "www.indiehackers.com": CAT.NEWS,
    "leetcode.com": CAT.LEARN,
    "www.hackerrank.com": CAT.LEARN,
    "www.coursera.org": CAT.LEARN,
    "www.udemy.com": CAT.LEARN,
    "www.khanacademy.org": CAT.LEARN,
    "www.duolingo.com": CAT.LEARN,
    "zoom.us": CAT.WORK,
    "www.zoom.us": CAT.WORK,
    "www.dropbox.com": CAT.WORK,
    "www.box.com": CAT.WORK,
    "onedrive.live.com": CAT.WORK,
    "www.icloud.com": CAT.WORK,
    "www.paypal.com": CAT.SHOP,
    "stripe.com": CAT.WORK,
    "dashboard.stripe.com": CAT.WORK,
    "www.airbnb.com": CAT.SHOP,
    "www.booking.com": CAT.SHOP,
    "www.expedia.com": CAT.SHOP,
    "www.imdb.com": CAT.FUN,
    "www.themoviedb.org": CAT.FUN,
    "letterboxd.com": CAT.FUN,
    "www.goodreads.com": CAT.LEARN,
    "archive.org": CAT.LEARN,
    "www.archive.org": CAT.LEARN,
  };

  if (exactHost[host]) add(exactHost[host], 8);

  const suffixRules = [
    ["youtube.com", CAT.VIDEO, 7],
    ["youtu.be", CAT.VIDEO, 7],
    ["github.io", CAT.DEV, 6],
    ["githubusercontent.com", CAT.DEV, 5],
    ["gitlab.io", CAT.DEV, 6],
    ["appspot.com", CAT.DEV, 3],
    ["cloudfunctions.net", CAT.DEV, 4],
    ["azurewebsites.net", CAT.DEV, 4],
    ["vercel.app", CAT.DEV, 6],
    ["netlify.app", CAT.DEV, 6],
    ["pages.dev", CAT.DEV, 5],
    ["readthedocs.io", CAT.DEV, 6],
    ["stackoverflow.com", CAT.DEV, 7],
    ["stackexchange.com", CAT.DEV, 6],
    ["reddit.com", CAT.SOCIAL, 6],
    ["redditstatic.com", CAT.SOCIAL, 2],
    ["slack.com", CAT.WORK, 6],
    ["slack-edge.com", CAT.SOCIAL, 1],
    ["notion.so", CAT.WORK, 6],
    ["notion.site", CAT.WORK, 6],
    ["google.com", CAT.LEARN, 2],
    ["googleapis.com", CAT.DEV, 3],
    ["microsoft.com", CAT.WORK, 3],
    ["office.com", CAT.WORK, 4],
    ["live.com", CAT.WORK, 3],
    ["amazonaws.com", CAT.DEV, 2],
    ["cloudflare.com", CAT.DEV, 3],
    ["fastly.net", CAT.DEV, 2],
    ["shopify.com", CAT.SHOP, 5],
    ["myshopify.com", CAT.SHOP, 6],
    ["stripe.com", CAT.WORK, 4],
    ["paypal.com", CAT.SHOP, 4],
    ["ebay.com", CAT.SHOP, 5],
    ["etsy.com", CAT.SHOP, 5],
    ["wikipedia.org", CAT.LEARN, 7],
    ["wikimedia.org", CAT.LEARN, 3],
    ["medium.com", CAT.NEWS, 5],
    ["substack.com", CAT.NEWS, 6],
    ["wordpress.com", CAT.NEWS, 3],
    ["blogspot.com", CAT.NEWS, 4],
    ["tumblr.com", CAT.SOCIAL, 4],
    ["pinterest.com", CAT.SOCIAL, 4],
    ["discord.com", CAT.SOCIAL, 5],
    ["discordapp.com", CAT.SOCIAL, 5],
    ["twitter.com", CAT.SOCIAL, 6],
    ["x.com", CAT.SOCIAL, 6],
    ["facebook.com", CAT.SOCIAL, 5],
    ["instagram.com", CAT.SOCIAL, 5],
    ["linkedin.com", CAT.SOCIAL, 5],
    ["tiktok.com", CAT.SOCIAL, 5],
    ["twitch.tv", CAT.VIDEO, 6],
    ["vimeo.com", CAT.VIDEO, 5],
    ["netflix.com", CAT.FUN, 6],
    ["spotify.com", CAT.FUN, 5],
    ["soundcloud.com", CAT.FUN, 4],
    ["imdb.com", CAT.FUN, 5],
    ["nytimes.com", CAT.NEWS, 6],
    ["washingtonpost.com", CAT.NEWS, 5],
    ["theguardian.com", CAT.NEWS, 5],
    ["bbc.co.uk", CAT.NEWS, 5],
    ["bbc.com", CAT.NEWS, 5],
    ["cnn.com", CAT.NEWS, 5],
    ["reuters.com", CAT.NEWS, 5],
    ["bloomberg.com", CAT.NEWS, 5],
    ["forbes.com", CAT.NEWS, 4],
    ["techcrunch.com", CAT.NEWS, 5],
    ["theverge.com", CAT.NEWS, 5],
    ["wired.com", CAT.NEWS, 5],
    ["npmjs.com", CAT.DEV, 7],
    ["python.org", CAT.DEV, 3],
    ["nodejs.org", CAT.DEV, 4],
    ["rust-lang.org", CAT.DEV, 4],
    ["go.dev", CAT.DEV, 5],
    ["kubernetes.io", CAT.DEV, 4],
    ["docker.com", CAT.DEV, 4],
    ["hashicorp.com", CAT.DEV, 4],
    ["mongodb.com", CAT.DEV, 3],
    ["postgresql.org", CAT.DEV, 3],
    ["mysql.com", CAT.DEV, 2],
    ["jetbrains.com", CAT.DEV, 3],
    ["atlassian.com", CAT.WORK, 4],
    ["jira.com", CAT.WORK, 5],
    ["figma.com", CAT.WORK, 5],
    ["dropbox.com", CAT.WORK, 4],
    ["zoom.us", CAT.WORK, 5],
    ["salesforce.com", CAT.WORK, 4],
    ["hubspot.com", CAT.WORK, 3],
    ["zendesk.com", CAT.WORK, 3],
    ["intercom.io", CAT.WORK, 3],
    ["typeform.com", CAT.WORK, 2],
    ["airtable.com", CAT.WORK, 4],
    ["clickup.com", CAT.WORK, 4],
    ["monday.com", CAT.WORK, 4],
    ["coda.io", CAT.WORK, 4],
    ["miro.com", CAT.WORK, 4],
    ["loom.com", CAT.WORK, 3],
    ["calendly.com", CAT.WORK, 3],
    ["docusign.com", CAT.WORK, 3],
    ["github.com", CAT.DEV, 7],
    ["gitlab.com", CAT.DEV, 6],
    ["bitbucket.org", CAT.DEV, 6],
    ["apache.org", CAT.DEV, 3],
    ["gnu.org", CAT.DEV, 2],
    ["arxiv.org", CAT.LEARN, 5],
    ["doi.org", CAT.LEARN, 3],
  ];

  const parts = host.split(".").filter(Boolean);
  suffixLoop: for (let len = Math.min(parts.length, 6); len >= 2; len--) {
    const suf = parts.slice(-len).join(".");
    for (const [sfx, cat, w] of suffixRules) {
      if (suf === sfx) {
        add(cat, w);
        break suffixLoop;
      }
    }
  }

  if (/\.edu(\.|$)/i.test(host)) add(CAT.LEARN, 3);
  if (/\.(gov|mil)(\.|$)/i.test(host)) add(CAT.WORK, 2);

  const subPrefixes = [
    [/^mail\./, CAT.WORK, 4],
    [/^webmail\./, CAT.WORK, 4],
    [/^inbox\./, CAT.WORK, 3],
    [/^docs?\./, CAT.DEV, 4],
    [/^api\./, CAT.DEV, 4],
    [/^dev\./, CAT.DEV, 3],
    [/^git\./, CAT.DEV, 3],
    [/^npm\./, CAT.DEV, 3],
    [/^repo\./, CAT.DEV, 2],
    [/^wiki\./, CAT.LEARN, 3],
    [/^blog\./, CAT.NEWS, 3],
    [/^news\./, CAT.NEWS, 3],
    [/^shop\./, CAT.SHOP, 3],
    [/^store\./, CAT.SHOP, 3],
    [/^app\./, CAT.WORK, 2],
    [/^dashboard\./, CAT.WORK, 2],
    [/^portal\./, CAT.WORK, 2],
    [/^admin\./, CAT.WORK, 2],
    [/^cdn\./, CAT.DEV, 1],
    [/^static\./, CAT.DEV, 1],
  ];
  for (const [re, cat, w] of subPrefixes) {
    if (re.test(host)) add(cat, w);
  }

  const pathRules = [
    [/\/(watch|embed|shorts\/|live\/|v\/|video\/|player\/)/i, CAT.VIDEO, 3],
    [/[?&]v=/i, CAT.VIDEO, 2],
    [/\/(product|products|p\/|item\/|shop|cart|checkout|basket|order)/i, CAT.SHOP, 3],
    [/\/(docs?|reference|api\/|swagger|openapi|redoc)/i, CAT.DEV, 3],
    [/\/(blog|news|article|posts?|stories?|magazine)\b/i, CAT.NEWS, 2],
    [/\/(login|signin|sign-in|auth|oauth|account|settings|dashboard|workspace)\b/i, CAT.WORK, 2],
    [/\/(course|learn|lesson|tutorial)/i, CAT.LEARN, 2],
    [/\/(forum|community|discuss|threads|messages)\b/i, CAT.SOCIAL, 2],
  ];
  for (const [re, cat, w] of pathRules) {
    if (re.test(path)) add(cat, w);
  }

  const hostHints = [
    [/mail|inbox|webmail|smtp|imap|outlook|gmail|proton\.me|fastmail/, CAT.WORK, 2],
    [/slack|zoom|teams|meet\.|calendar|notion|asana|trello|jira|confluence|linear\.|figma|canva|office|sharepoint/, CAT.WORK, 2],
    [/github|gitlab|bitbucket|npm|pypi|crates\.|stackoverflow|stackexchange|mdn\.|devdocs|kubernetes|docker|terraform/, CAT.DEV, 2],
    [/youtube|twitch|vimeo|netflix|hulu|disney|hbo|stream|video/, CAT.VIDEO, 2],
    [/news|times|post|herald|tribune|daily|gazette|magazine|journal|press|media\.|substack|medium/, CAT.NEWS, 2],
    [/shop|store|cart|buy|deal|coupon|market|boutique|fashion|jewelry/, CAT.SHOP, 2],
    [/reddit|twitter|facebook|instagram|linkedin|tiktok|pinterest|discord|mastodon|bsky|forum|community/, CAT.SOCIAL, 2],
    [/wiki|learn|course|school|academy|textbook|study|quiz|khan|udemy|coursera/, CAT.LEARN, 2],
    [/game|gaming|steam|epicgames|itch\.io|roblox|minecraft|play\.|fun\.|entertainment/, CAT.FUN, 2],
    [/music|podcast|spotify|bandcamp|soundcloud|last\.fm|lyrics/, CAT.FUN, 2],
  ];
  for (const [re, cat, w] of hostHints) {
    if (re.test(host)) add(cat, w);
  }

  const blobRules = [
    [/\b(api|sdk|graphql|openapi|swagger)\b/i, CAT.DEV, 2],
    [/\b(pricing|subscribe|plan|billing)\b/i, CAT.WORK, 1],
  ];
  for (const [re, cat, w] of blobRules) {
    if (re.test(full)) add(cat, w);
  }

  const max = Math.max(0, ...Object.values(s));
  if (max < 1) {
    if (/\.(io|dev|tools|tech|cloud|ai|app)(\.|$)/i.test(host)) {
      add(CAT.DEV, 2);
      add(CAT.WORK, 1);
    } else {
      add(CAT.LEARN, 1);
      add(CAT.WORK, 1);
    }
  }

  return s;
}

/**
 * @param {Record<string, number>} a
 * @param {Record<string, number>} b
 */
function mergeCategoryScores(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === "number" && !Number.isNaN(v)) o[k] = (o[k] || 0) + v;
  }
  return o;
}

/**
 * @param {Record<string, number>} scores
 */
function pickBestCategory(scores) {
  let best = CAT.OTHER;
  let bestS = -Infinity;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestS) {
      bestS = v;
      best = k;
    } else if (v === bestS && v > 0) {
      const ia = TIE_BREAK.indexOf(k);
      const ib = TIE_BREAK.indexOf(best);
      if (ia !== -1 && (ib === -1 || ia < ib)) best = k;
    }
  }
  if (bestS <= 0) return CAT.OTHER;
  return best;
}

/** If URL-only scores are decisive, skip slow executeScript during preview. */
const URL_SCORE_SKIP_INJECT_MIN_TOP = 6;
const URL_SCORE_SKIP_INJECT_GAP = 2.5;

/**
 * @param {Record<string, number>} scores
 * @returns {boolean}
 */
function urlScoresStrongEnoughToSkipInject(scores) {
  const vals = Object.values(scores)
    .filter((v) => typeof v === "number" && !Number.isNaN(v))
    .sort((a, b) => b - a);
  const top = vals[0] ?? 0;
  const second = vals[1] ?? 0;
  return top >= URL_SCORE_SKIP_INJECT_MIN_TOP && top - second >= URL_SCORE_SKIP_INJECT_GAP;
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, limit, fn) {
  const out = /** @type {R[]} */ (new Array(items.length));
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/**
 * `injectedClassifyPage` is defined in classify.js (loaded before this script).
 * Merges URL-only scores (always) with injected page scores (meta, JSON-LD, path).
 * @param {chrome.tabs.Tab} tab
 * @param {boolean} [injectMeta=true] If false, skip executeScript (no optional host permission).
 * @returns {Promise<{ category: string; tabId?: number }>}
 */
async function classifyOneTab(tab, injectMeta = true) {
  const tabId = tab.id;
  if (tabId == null) return { category: CAT.OTHER };

  let urlScores = {};
  try {
    const u = new URL(tab.url || "");
    if (u.protocol === "http:" || u.protocol === "https:") {
      urlScores = urlClassificationScores(tab.url || "");
    } else {
      return { category: CAT.OTHER, tabId };
    }
  } catch {
    return { category: CAT.OTHER, tabId };
  }

  let pageScores = {};
  const skipInject =
    !injectMeta || urlScoresStrongEnoughToSkipInject(urlScores);
  if (!tab.discarded && !skipInject) {
    try {
      const TIMEOUT_MS = 2500;
      const execPromise = chrome.scripting.executeScript({
        target: { tabId },
        func: injectedClassifyPage,
      });
      const timeoutPromise = new Promise((_, rej) => {
        setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS);
      });
      const res = await Promise.race([execPromise, timeoutPromise]);
      const first = Array.isArray(res) ? res[0] : res;
      const raw = first?.result;
      if (raw && typeof raw === "object" && raw.scores && typeof raw.scores === "object") {
        pageScores = raw.scores;
      } else if (raw && typeof raw === "object" && raw.category) {
        pageScores = { [raw.category]: 5 };
      }
    } catch {
      /* URL scores still apply */
    }
  }

  const merged = mergeCategoryScores(urlScores, pageScores);
  return { category: pickBestCategory(merged), tabId };
}

/**
 * @param {(p: { done: number; total: number }) => void} [onProgress]
 * @param {boolean} [injectMeta=true] Pass false when optional host permission was denied (URL-only classify).
 * @returns {Promise<{
 *   before: {
 *     windowCount: number;
 *     totalTabs: number;
 *     allTabsInBrowser: number;
 *     movableTotal: number;
 *     skippedCount: number;
 *     chromeOrBlankCount: number;
 *     pinnedInScopeCount: number;
 *     toMoveCount: number;
 *     leftUnmoved: number;
 *     perWindow: { id?: number; focused: boolean; tabCount: number; movableCount: number }[];
 *   };
 *   after: { categoryWindowCount: number; groups: { name: string; tabIds: number[] }[] };
 * }>}
 */
async function computeMetadataOrganizePreview(onProgress, injectMeta = true) {
  const allWindows = await chrome.windows.getAll({ populate: true });
  const allTabs = await chrome.tabs.query({});
  const normalTabs = await getNormalTabs();
  const movableAll = allTabs
    .filter(isOrganizableTab)
    .sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return (a.index ?? 0) - (b.index ?? 0);
    });

  const capped = movableAll.slice(0, MAX_ORGANIZE_TABS_CLASSIFY);
  const toClassify = capped;
  const leftUnmoved = movableAll.length - toClassify.length;
  const total = toClassify.length;
  const poolSize = Math.min(24, Math.max(8, Math.ceil(toClassify.length / 30)));

  let done = 0;
  const classifications = await mapPool(toClassify, poolSize, async (t) => {
    const r = await classifyOneTab(t, injectMeta);
    done += 1;
    onProgress?.({ done, total });
    return r;
  });

  const byCat = new Map();
  for (let i = 0; i < toClassify.length; i++) {
    const tab = toClassify[i];
    const id = tab.id;
    if (id == null) continue;
    const cat = classifications[i]?.category || "Other";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(id);
  }

  const groups = [];
  for (const [name, tabIds] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push(...splitCategoryIntoWindows(name, tabIds, MAX_TABS_PER_CATEGORY_WINDOW));
  }

  const chromeOrBlankCount = allTabs.filter(
    (t) => !t.url || t.url.startsWith("chrome://")
  ).length;
  const pinnedInScope = normalTabs.filter((t) => t.pinned).length;

  return {
    before: {
      windowCount: allWindows.length,
      /** Same scope as analytics "Tab count" (excludes chrome://, needs URL + id). */
      totalTabs: normalTabs.length,
      allTabsInBrowser: allTabs.length,
      movableTotal: movableAll.length,
      skippedCount: allTabs.length - movableAll.length,
      chromeOrBlankCount,
      pinnedInScopeCount: pinnedInScope,
      toMoveCount: toClassify.length,
      leftUnmoved,
      perWindow: allWindows.map((w) => ({
        id: w.id,
        focused: !!w.focused,
        tabCount: w.tabs?.length ?? 0,
        movableCount: (w.tabs || []).filter(isOrganizableTab).length,
      })),
    },
    after: {
      categoryWindowCount: groups.length,
      groups,
    },
  };
}

/**
 * @param {HTMLElement} wrap
 * @param {boolean} show
 */
function togglePreviewPanel(wrap, show) {
  wrap.classList.toggle("hidden", !show);
  wrap.hidden = !show;
}

document.addEventListener("DOMContentLoaded", () => {
  const analyticsEl = document.getElementById("analytics");
  const statusEl = document.getElementById("status");
  const closeDupesBtn = document.getElementById("closeDupes");
  const exportLinksBtn = document.getElementById("exportLinks");
  const closeAndExportBtn = document.getElementById("closeAndExport");
  const previewOrganizeBtn = document.getElementById("previewOrganize");
  const organizePreviewWrap = document.getElementById("organizePreview");
  const organizeBeforeEl = document.getElementById("organizeBefore");
  const organizeAfterEl = document.getElementById("organizeAfter");
  const organizeGroupsEl = document.getElementById("organizeGroups");
  const applyOrganizeBtn = document.getElementById("applyOrganize");
  const cancelOrganizeBtn = document.getElementById("cancelOrganizePreview");

  /** @type {Awaited<ReturnType<typeof computeMetadataOrganizePreview>> | null} */
  let lastOrganizePreview = null;

  async function refreshAnalytics() {
    const tabs = await getNormalTabs();
    const { analytics } = partitionDuplicates(tabs);
    renderAnalytics(analyticsEl, analytics);
    logAnalytics("snapshot", analytics);
    return { tabs, analytics };
  }

  refreshAnalytics().catch((e) => {
    setStatus(statusEl, String(e?.message || e), true);
  });

  closeDupesBtn.addEventListener("click", async () => {
    setStatus(statusEl, "Working…");
    try {
      const tabs = await getNormalTabs();
      const { close, analytics } = partitionDuplicates(tabs);
      logAnalytics("before close duplicates", analytics);
      if (close.length === 0) {
        setStatus(
          statusEl,
          `No duplicates to close. Tabs: ${analytics.totalTabs}, unique URLs: ${analytics.uniqueUrls}.`
        );
        renderAnalytics(analyticsEl, analytics);
        return;
      }
      await chrome.tabs.remove(close.map((t) => t.id));
      logAnalytics("closed duplicate tabs", analytics, { closed: close.length });
      setStatus(
        statusEl,
        `Closed ${close.length} tab(s). Was ${analytics.totalTabs} tabs (${analytics.uniqueUrls} unique URLs); removed ${analytics.duplicateTabs} duplicate instance(s) in ${analytics.duplicateGroups} group(s).`
      );
      const after = await refreshAnalytics();
      logAnalytics("after close", after.analytics, { closed: close.length });
    } catch (e) {
      setStatus(statusEl, String(e?.message || e), true);
    }
  });

  exportLinksBtn.addEventListener("click", async () => {
    setStatus(statusEl, "Exporting…");
    try {
      const tabs = await getNormalTabs();
      const { analytics } = partitionDuplicates(tabs);
      const urls = [...new Set(tabs.map((t) => t.url).filter(Boolean))];
      downloadTxt(urls);
      logAnalytics("export links", analytics, { exported: urls.length });
      setStatus(
        statusEl,
        `Exported ${urls.length} unique link(s). Tabs counted: ${analytics.totalTabs}.`
      );
    } catch (e) {
      setStatus(statusEl, String(e?.message || e), true);
    }
  });

  closeAndExportBtn.addEventListener("click", async () => {
    setStatus(statusEl, "Working…");
    try {
      const tabs = await getNormalTabs();
      const { close, analytics } = partitionDuplicates(tabs);
      const uniqueBefore = [...new Set(tabs.map((t) => t.url).filter(Boolean))];
      logAnalytics("before close and export", analytics, {
        exported: uniqueBefore.length,
      });
      if (close.length > 0) {
        await chrome.tabs.remove(close.map((t) => t.id));
      }
      downloadTxt(uniqueBefore);
      logAnalytics("after close and export", analytics, {
        closed: close.length,
        exported: uniqueBefore.length,
      });
      setStatus(
        statusEl,
        close.length
          ? `Closed ${close.length} duplicate tab(s). Exported ${uniqueBefore.length} unique link(s). (Had ${analytics.totalTabs} tabs, ${analytics.duplicateGroups} duplicate group(s).)`
          : `No duplicates closed. Exported ${uniqueBefore.length} unique link(s). Tabs: ${analytics.totalTabs}.`
      );
      await refreshAnalytics();
    } catch (e) {
      setStatus(statusEl, String(e?.message || e), true);
    }
  });

  /** @param {string} s */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderOrganizePreview(p) {
    const { before, after } = p;
    const winLines = before.perWindow
      .map(
        (w, i) =>
          `<li>Window ${i + 1}${w.focused ? " (focused)" : ""}: ${w.tabCount} tab(s), ${w.movableCount} will move</li>`
      )
      .join("");
    const capNote =
      before.leftUnmoved > 0
        ? ` <strong>${before.leftUnmoved}</strong> movable tab(s) exceed the preview cap (${MAX_ORGANIZE_TABS_CLASSIFY}) and were skipped.`
        : "";
    const scopeNote =
      before.allTabsInBrowser !== before.totalTabs
        ? `<p class="subtle">Chrome has <strong>${before.allTabsInBrowser}</strong> tab row(s) total; <strong>${before.totalTabs}</strong> match the header &quot;Tab count&quot; (http(s)/about/etc., excludes <code>chrome://</code> and tabs with no URL).</p>`
        : "";
    organizeBeforeEl.innerHTML = `
      <h3>Before (current)</h3>
      <p><strong>${before.windowCount}</strong> browser window(s), <strong>${before.totalTabs}</strong> tab(s) in scope (same as analytics).</p>
      ${scopeNote}
      <p><strong>${before.movableTotal}</strong> movable (unpinned, in-scope); this run classifies &amp; moves <strong>${before.toMoveCount}</strong> (all of them unless capped). Not movable: <strong>${before.skippedCount}</strong> — <strong>${before.chromeOrBlankCount}</strong> <code>chrome://</code>/no URL, <strong>${before.pinnedInScopeCount}</strong> pinned in-scope.${capNote}</p>
      <p class="subtle">Per-window &quot;tabs&quot; below is every row in that window (includes chrome pages).</p>
      <ul>${winLines}</ul>
    `;
    const batchCount = splitOrganizeGroupsIntoBatches(
      after.groups,
      MAX_WINDOWS_PER_APPLY,
      MAX_TABS_PER_APPLY
    ).length;
    const batchNote =
      batchCount > 1
        ? ` Apply uses <strong>${batchCount}</strong> automatic batches (≤${MAX_WINDOWS_PER_APPLY} windows & ≤${MAX_TABS_PER_APPLY} tabs each).`
        : "";
    organizeAfterEl.innerHTML = `
      <h3>After (planned)</h3>
      <p><strong>${after.categoryWindowCount}</strong> window(s) for <strong>${before.toMoveCount}</strong> tab(s). Categories split at <strong>${MAX_TABS_PER_CATEGORY_WINDOW}</strong> tabs per window.</p>
      <p class="subtle">${batchNote} Uses page metadata; failures land in &quot;Other&quot;. Tune batch sizes in <code>limits.js</code>.</p>
    `;
    const rows = after.groups
      .map(
        (g) =>
          `<tr><td>${escapeHtml(g.name)}</td><td>${g.tabIds.length}</td></tr>`
      )
      .join("");
    organizeGroupsEl.innerHTML = `
      <table>
        <thead><tr><th>Category</th><th>Tabs</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    const hintEl = document.getElementById("organizeBatchHint");
    if (hintEl) {
      if (batchCount > 1) {
        hintEl.textContent = `Apply will run ${batchCount} batches automatically, with pauses between batches (see limits.js).`;
        hintEl.classList.remove("hidden");
        hintEl.hidden = false;
      } else {
        hintEl.textContent = "";
        hintEl.classList.add("hidden");
        hintEl.hidden = true;
      }
    }
  }

  previewOrganizeBtn.addEventListener("click", async () => {
    setStatus(statusEl, "Optional: allow site access for richer page metadata…");
    let injectMeta = true;
    try {
      injectMeta = await requestOptionalHostPermission();
    } catch {
      injectMeta = false;
    }
    if (!injectMeta) {
      setStatus(
        statusEl,
        "Using URL-only categories (optional site access declined). Classifying…"
      );
    } else {
      setStatus(statusEl, "Classifying tabs (metadata)…");
    }
    try {
      lastOrganizePreview = await computeMetadataOrganizePreview(
        ({ done, total }) => {
          setStatus(statusEl, `Reading metadata… ${done}/${total} tab(s).`);
        },
        injectMeta
      );
      if (lastOrganizePreview.before.movableTotal === 0) {
        setStatus(statusEl, "Nothing to organize: no movable tabs (check pinned / chrome pages).");
        togglePreviewPanel(organizePreviewWrap, false);
        lastOrganizePreview = null;
        return;
      }
      if (lastOrganizePreview.before.toMoveCount === 0) {
        setStatus(statusEl, "Nothing to move in this batch.");
        togglePreviewPanel(organizePreviewWrap, false);
        lastOrganizePreview = null;
        return;
      }
      renderOrganizePreview(lastOrganizePreview);
      togglePreviewPanel(organizePreviewWrap, true);
      applyOrganizeBtn.disabled = false;
      const capMsg =
        lastOrganizePreview.before.leftUnmoved > 0
          ? ` (${lastOrganizePreview.before.leftUnmoved} over ${MAX_ORGANIZE_TABS_CLASSIFY} preview cap — not included)`
          : "";
      setStatus(
        statusEl,
        `Preview: ${lastOrganizePreview.before.windowCount} window(s) now → ${lastOrganizePreview.after.categoryWindowCount} category window(s) for ${lastOrganizePreview.before.toMoveCount} tab(s).${capMsg}`
      );
      console.log("[Tabby] organize preview (metadata)", lastOrganizePreview);
    } catch (e) {
      setStatus(statusEl, String(e?.message || e), true);
      lastOrganizePreview = null;
    }
  });

  cancelOrganizeBtn.addEventListener("click", () => {
    lastOrganizePreview = null;
    togglePreviewPanel(organizePreviewWrap, false);
    const h = document.getElementById("organizeBatchHint");
    if (h) {
      h.textContent = "";
      h.classList.add("hidden");
      h.hidden = true;
    }
    setStatus(statusEl, "Preview dismissed.");
  });

  applyOrganizeBtn.addEventListener("click", async () => {
    if (!lastOrganizePreview) {
      setStatus(statusEl, "Run preview first.", true);
      return;
    }
    applyOrganizeBtn.disabled = true;
    try {
      const groups = lastOrganizePreview.after.groups;
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      await chrome.storage.session.set({
        organizeJob: { groups, runId },
        organizeActiveRunId: runId,
        organizeProgress: null,
      });
      await chrome.windows.create({
        url: chrome.runtime.getURL("progress.html"),
        type: "popup",
        width: 420,
        height: 300,
        focused: true,
      });
      setStatus(
        statusEl,
        "Progress window opened — apply runs in the background. Reopen this popup later to refresh counts."
      );
      lastOrganizePreview = null;
      togglePreviewPanel(organizePreviewWrap, false);
      applyOrganizeBtn.disabled = false;
      window.close();
    } catch (e) {
      setStatus(statusEl, String(e?.message || e), true);
      applyOrganizeBtn.disabled = false;
    }
  });
});
