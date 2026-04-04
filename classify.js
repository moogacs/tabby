/**
 * Injected into each tab via chrome.scripting.executeScript.
 * Must be self-contained (no closure over popup scope).
 * @returns {{ category: string; host: string }}
 */
function injectedClassifyPage() {
  const C = {
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

  /** @type {Record<string, number>} */
  const score = {};
  const add = (cat, w) => {
    score[cat] = (score[cat] || 0) + w;
  };

  const host = (location.hostname || "").toLowerCase();
  const title = (document.title || "").toLowerCase();

  const hostRules = [
    [/^(www\.)?youtube\.com$/, C.VIDEO],
    [/^(www\.)?youtu\.be$/, C.VIDEO],
    [/^(www\.)?twitch\.tv$/, C.VIDEO],
    [/^(www\.)?vimeo\.com$/, C.VIDEO],
    [/^(www\.)?netflix\.com$/, C.FUN],
    [/^(www\.)?github\.com$/, C.DEV],
    [/^gist\.github\.com$/, C.DEV],
    [/^stackoverflow\.com$/, C.DEV],
    [/^(.*\.)?stackoverflow\.com$/, C.DEV],
    [/^(www\.)?reddit\.com$/, C.SOCIAL],
    [/^twitter\.com$/, C.SOCIAL],
    [/^x\.com$/, C.SOCIAL],
    [/^(www\.)?facebook\.com$/, C.SOCIAL],
    [/^(www\.)?linkedin\.com$/, C.SOCIAL],
    [/^(www\.)?instagram\.com$/, C.SOCIAL],
    [/^(www\.)?tiktok\.com$/, C.SOCIAL],
    [/^(www\.)?amazon\./, C.SHOP],
    [/^(www\.)?ebay\./, C.SHOP],
    [/^(www\.)?etsy\.com$/, C.SHOP],
    [/^(www\.)?shopify\.com$/, C.SHOP],
    [/^(docs\.google\.com|drive\.google\.com)$/, C.WORK],
    [/^(mail\.|www\.)?google\.com$/, C.WORK],
    [/^(www\.)?notion\.(so|site)$/, C.WORK],
    [/^(www\.)?figma\.com$/, C.WORK],
    [/^(www\.)?wikipedia\.org$/, C.LEARN],
    [/^(www\.)?medium\.com$/, C.NEWS],
    [/^(www\.)?bbc\.(com|co\.uk)$/, C.NEWS],
    [/^(www\.)?cnn\.com$/, C.NEWS],
    [/^(www\.)?nytimes\.com$/, C.NEWS],
    [/^(developer\.mozilla\.org|learn\.microsoft\.com)$/, C.DEV],
  ];

  for (const [re, cat] of hostRules) {
    if (re.test(host)) {
      add(cat, 5);
      break;
    }
  }

  /** @type {Record<string, string>} */
  const metas = {};
  document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
    const k = (m.getAttribute("property") || m.getAttribute("name") || "").toLowerCase();
    const v = (m.getAttribute("content") || "").toLowerCase();
    if (k) metas[k] = v;
  });

  const ogType = metas["og:type"] || "";
  if (ogType.includes("video")) add(C.VIDEO, 4);
  if (ogType.includes("article")) add(C.NEWS, 3);
  if (ogType.includes("product")) add(C.SHOP, 4);
  if (ogType === "website") add(C.WORK, 1);
  if (ogType.includes("music")) add(C.FUN, 2);
  if (ogType.includes("book")) add(C.LEARN, 2);

  const twCard = metas["twitter:card"] || "";
  if (twCard.includes("player")) add(C.VIDEO, 2);

  const textBlob = [
    title,
    metas["description"],
    metas["og:title"],
    metas["og:description"],
    metas["twitter:title"],
    metas["twitter:description"],
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const textRules = [
    [/\b(tutorial|documentation|sdk|api reference|github|npm package|repository|changelog|release notes)\b/i, C.DEV, 3],
    [/\b(sale|free shipping|add to cart|checkout|buy now|price:|€|\$|£|sku)\b/i, C.SHOP, 3],
    [/\b(breaking news|subscribe|newsletter|editorial|opinion column)\b/i, C.NEWS, 2],
    [/\b(episode|season \d|trailer|full movie|live stream)\b/i, C.VIDEO, 2],
    [/\b(login|sign in|dashboard|workspace|settings|account)\b/i, C.WORK, 2],
    [/\b(course|lesson|syllabus|textbook|quiz|certification)\b/i, C.LEARN, 2],
    [/\b(forum|thread|replies|community guidelines)\b/i, C.SOCIAL, 2],
  ];
  for (const [re, cat, w] of textRules) {
    if (re.test(textBlob)) add(cat, w);
  }

  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const types = [];
      const walk = (o) => {
        if (!o) return;
        if (Array.isArray(o)) {
          o.forEach(walk);
          return;
        }
        if (typeof o === "object") {
          const t = o["@type"];
          if (t) {
            const arr = Array.isArray(t) ? t : [t];
            arr.forEach((x) => types.push(String(x).toLowerCase()));
          }
          Object.values(o).forEach((v) => {
            if (v && typeof v === "object") walk(v);
          });
        }
      };
      walk(JSON.parse(s.textContent.trim()));
      types.forEach((tt) => {
        if (tt.includes("newsarticle") || tt.includes("blogposting") || tt.includes("blog")) {
          add(C.NEWS, 4);
        }
        if (tt.includes("product")) add(C.SHOP, 4);
        if (tt.includes("techarticle") || tt.includes("softwareapplication") || tt.includes("code")) {
          add(C.DEV, 3);
        }
        if (tt.includes("videoobject") || tt.includes("movie") || tt.includes("tvepisode")) {
          add(C.VIDEO, 4);
        }
        if (tt.includes("course") || tt.includes("learningresource")) {
          add(C.LEARN, 2);
        }
        if (tt.includes("webpage")) add(C.LEARN, 0.25);
        if (tt.includes("organization") || tt.includes("localbusiness")) add(C.WORK, 1);
      });
    } catch {
      /* ignore bad JSON-LD */
    }
  });

  if (/\b(api|sdk|documentation|docs)\b/i.test(title)) add(C.DEV, 2);
  if (/\b(sale|buy|cart|shop)\b/i.test(title)) add(C.SHOP, 1);

  const path = (location.pathname || "") + (location.search || "");
  if (/\/(watch|embed|shorts\/|live\/|v\/)/i.test(path)) add(C.VIDEO, 3);
  if (/\/(product|products|shop|cart|checkout|basket|item\/)/i.test(path)) add(C.SHOP, 2);
  if (/\/(docs?|reference|api\/|swagger|openapi)/i.test(path)) add(C.DEV, 3);
  if (/\/(blog|news|article|posts?|story\/)/i.test(path)) add(C.NEWS, 2);

  return { scores: score, host };
}
