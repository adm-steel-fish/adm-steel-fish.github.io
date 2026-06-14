// Injects Open Graph / Twitter Card meta tags into news-article.html
// based on the requested article's id, so links shared on Twitter/X,
// Bluesky, Discord, etc. show a rich preview (title, description, image).

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
  const image = article.thumbnail
    ? new URL(article.thumbnail, url).href
    : new URL("/images/logo_inverted.png", url).href;

  const metaTags = `
    <meta property="og:type" content="article">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${escapeHtml(image)}">
    <meta property="og:url" content="${escapeHtml(url.href)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(image)}">
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
