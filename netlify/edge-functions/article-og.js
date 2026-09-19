// Injects Open Graph / Twitter Card meta tags into news-article.html
// based on the requested article's id, so links shared on Twitter/X,
// Bluesky, Discord, etc. show a rich preview (title, description, image).

// X/Twitter will not render an animated image in a link card, so an article
// whose thumbnail is a GIF (or YouTube's animated `an_webp` hover preview)
// shows an empty card. Every thumbnail is therefore resolved to a plain,
// static JPEG before it is advertised to crawlers, and anything that still
// can't be resolved falls back to the studio's generic card.

const DEFAULT_IMAGE = "/images/og-default.jpg";
const CARD_W = 1200;
const CARD_H = 630;
const PROBE_TIMEOUT_MS = 2500;

// Formats that may be animated, so they need flattening to a still frame.
const ANIMATED_TYPES = /^image\/(gif|webp|apng|avif)$/i;
const ANIMATED_EXT = /\.(gif|webp|apng|avif)$/i;

const YT_ID = /^[\w-]{11}$/;

// Any ytimg thumbnail path carries the video id: /an_webp/<id>/…, /vi/<id>/…,
// /vi_webp/<id>/…  The animated and `oar2`/`sqp` variants are also signed with
// an expiring token, so rebuilding the canonical still URL fixes both problems.
function youtubeId(u) {
  if (u.hostname !== "i.ytimg.com" && !u.hostname.endsWith(".ytimg.com")) {
    return null;
  }
  const m = u.pathname.match(/^\/(?:an_webp|vi|vi_webp)\/([^/]+)\//);
  return m && YT_ID.test(m[1]) ? m[1] : null;
}

// Netlify's Image CDN re-encodes a source image; `fm=jpg` flattens an animated
// source to its first frame, and serving from our own origin also sidesteps
// hosts that refuse hotlinks from the crawler.
function imageCdn(origin, src) {
  const out = new URL("/.netlify/images", origin);
  out.searchParams.set("url", src);
  out.searchParams.set("w", String(CARD_W));
  out.searchParams.set("h", String(CARD_H));
  out.searchParams.set("fit", "cover");
  out.searchParams.set("fm", "jpg");
  out.searchParams.set("q", "82");
  return out.href;
}

async function isReachable(href) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(href, { method: "HEAD", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves an article thumbnail to a static image X will render, as
// { url, width, height } — the dimensions are null when the source is passed
// through untouched and its size therefore isn't known here.
async function resolveSocialImage(thumbnail, pageUrl) {
  const origin = pageUrl.origin;
  const card = (url) => ({ url, width: CARD_W, height: CARD_H });
  const fallback = card(new URL(DEFAULT_IMAGE, origin).href);
  if (!thumbnail) return fallback;

  let src;
  try {
    src = new URL(thumbnail, pageUrl);
  } catch {
    return fallback;
  }
  if (src.protocol !== "https:" && src.protocol !== "http:") return fallback;

  const videoId = youtubeId(src);
  if (videoId) {
    // maxresdefault is a true 1280x720 still but doesn't exist for every video;
    // hqdefault always does, though it's 4:3 with letterbox bars, so it goes
    // through the Image CDN to be cropped back to the card's aspect ratio.
    const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    if (await isReachable(maxres)) {
      return { url: maxres, width: 1280, height: 720 };
    }

    const hqRaw = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const hqCropped = imageCdn(origin, hqRaw);
    if (await isReachable(hqCropped)) return card(hqCropped);

    // hqdefault exists for every video, so prefer the letterboxed still over
    // the generic card if the Image CDN is unavailable.
    return (await isReachable(hqRaw))
      ? { url: hqRaw, width: 480, height: 360 }
      : fallback;
  }

  // The Image CDN is preferred for every source: it flattens anything
  // animated, upscales thumbnails too small for a large card (X wants at
  // least 300x157), and crops everything to one consistent shape. It only
  // accepts allow-listed hosts — see [images] in netlify.toml — so an
  // unlisted host falls back to the original URL.
  const normalized = imageCdn(origin, src.href);
  if (await isReachable(normalized)) return card(normalized);

  // One probe answers both questions: whether the source loads at all, and —
  // for the many hosts that serve images from extensionless URLs — whether it
  // is a format that might be animated.
  const probe = await headProbe(src.href);
  const maybeAnimated =
    ANIMATED_EXT.test(src.pathname) || ANIMATED_TYPES.test(probe.type);

  return probe.ok && !maybeAnimated
    ? { url: src.href, width: null, height: null }
    : fallback;
}

// Returns { ok, type } for a URL, or { ok: false, type: "" } if it can't be
// reached before the timeout.
async function headProbe(href) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(href, { method: "HEAD", signal: ctrl.signal });
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    return { ok: res.ok, type };
  } catch {
    return { ok: false, type: "" };
  } finally {
    clearTimeout(timer);
  }
}

export default async (request, context) => {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const response = await context.next();

  if (!id) return response;

  const dataRes = await fetch(new URL("/news-data.js", url));
  if (!dataRes.ok) return response;
  const dataText = await dataRes.text();

  let articles;
  try {
    articles = new Function(dataText + "\nreturn NEWS_ARTICLES;")();
  } catch {
    return response;
  }

  const article = articles.find((a) => String(a.id) === id);
  if (!article) return response;

  const escapeHtml = (str) =>
    String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  const title = `${article.title} — Steel Fish Studios`;
  const description = article.summary
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const image = await resolveSocialImage(article.thumbnail, url);
  const imageSize = image.width
    ? `
    <meta property="og:image:width" content="${image.width}">` +
      `
    <meta property="og:image:height" content="${image.height}">`
    : "";

  const metaTags = `
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${escapeHtml(image.url)}">${imageSize}
    <meta property="og:url" content="${escapeHtml(url.href)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(image.url)}">
    <meta name="twitter:image:alt" content="${escapeHtml(article.title)}">
  `;

  let html = await response.text();
  html = html
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(title)}</title>`)
    // Remove the generic fallback og:/twitter: meta tags before inserting article-specific ones
    .replace(/\s*<meta (?:property="og:|name="twitter:)[^>]*>\n?/g, "")
    .replace("</head>", `${metaTags}</head>`);

  return new Response(html, response);
};

export const config = { path: "/news-article.html" };
