// Backend for the online News Editor (news-editor.html).
//
// Saving an article commits news-data.js (and any uploaded images/videos) to
// the GitHub repo, which triggers the usual Netlify deploy — so editors don't
// need a local copy of the site, Python, or git.
//
// Required environment variables (Netlify → Site configuration → Environment variables):
//   GITHUB_TOKEN   Fine-grained personal access token with "Contents: Read and write"
//                  on the site's repo only.
//   EDITOR_KEYS    Who may edit, as comma-separated Name:password pairs, e.g.
//                  "Alex:correct-horse-battery,Sam:another-long-password".
//                  The name is recorded in the commit message.
// Optional:
//   GITHUB_REPO    owner/repo (default: adm-steel-fish/adm-steel-fish.github.io)
//   GITHUB_BRANCH  (default: main)

import { createHash, timingSafeEqual } from "node:crypto";

const REPO = process.env.GITHUB_REPO || "adm-steel-fish/adm-steel-fish.github.io";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const DATA_PATH = "news-data.js";
const MARKER = "const NEWS_ARTICLES = [";
const MEDIA_PATH = /^images\/news\/[a-z0-9-]+(\.[a-z0-9]+)?$/;
const SHA = /^[0-9a-f]{40}$/;

// ---- Auth ----

function sha256(s) {
  return createHash("sha256").update(s).digest();
}

// Returns the editor's name for a valid password, or null.
function authenticate(req) {
  const given = req.headers.get("x-editor-password") || "";
  if (!given) return null;
  const givenHash = sha256(given);
  let name = null;
  for (const pair of (process.env.EDITOR_KEYS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i <= 0) continue;
    const password = pair.slice(i + 1).trim();
    // Compare every entry (no early exit) so timing doesn't reveal which matched.
    if (password && timingSafeEqual(sha256(password), givenHash) && !name) {
      name = pair.slice(0, i).trim();
    }
  }
  return name;
}

// ---- GitHub ----

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function readNewsData(ref) {
  // The raw media type works for files over 1 MB, unlike the default JSON one.
  const res = await gh(`/contents/${DATA_PATH}?ref=${ref}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  const text = await res.text();
  const idx = text.indexOf(MARKER);
  if (idx === -1) throw new Error(`Could not find "${MARKER}" in ${DATA_PATH}.`);
  const articles = new Function(text + "\nreturn NEWS_ARTICLES;")();
  return { header: text.slice(0, idx) + MARKER + "\n", articles };
}

// Same layout the local editor always wrote, so diffs stay readable.
function serializeArticle(article) {
  const lines = ["  {"];
  lines.push(`    id: ${article.id},`);
  lines.push(`    date: ${JSON.stringify(article.date)},`);
  if (article.tag) lines.push(`    tag: ${JSON.stringify(article.tag)},`);
  if (article.thumbnail) lines.push(`    thumbnail: ${JSON.stringify(article.thumbnail)},`);
  lines.push(`    title: ${JSON.stringify(article.title)},`);
  lines.push(`    summary: ${JSON.stringify(article.summary)},`);
  lines.push(`    content: ${JSON.stringify(article.content || "")},`);
  lines.push("  },");
  return lines.join("\n");
}

// Applies `edit` to the latest news-data.js and commits it together with any
// media blobs. The change is re-applied on top of the newest commit if someone
// else saved in the meantime, so concurrent edits to different articles never
// overwrite each other.
async function commitNewsChange(edit, media, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await (await gh(`/git/ref/heads/${BRANCH}`)).json();
    const parentSha = ref.object.sha;
    const parent = await (await gh(`/git/commits/${parentSha}`)).json();

    const { header, articles } = await readNewsData(parentSha);
    const result = edit(articles);
    const text = header + articles.map(serializeArticle).join("\n") + "\n];\n";

    const blob = await (await gh("/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content: text, encoding: "utf-8" }),
    })).json();

    const tree = await (await gh("/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: parent.tree.sha,
        tree: [
          { path: DATA_PATH, mode: "100644", type: "blob", sha: blob.sha },
          ...media.map((m) => ({ path: m.path, mode: "100644", type: "blob", sha: m.sha })),
        ],
      }),
    })).json();

    const commit = await (await gh("/git/commits", {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
    })).json();

    try {
      await gh(`/git/refs/heads/${BRANCH}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      return result;
    } catch (err) {
      // 422 = the branch moved since we read it; retry on the new head.
      if (err.status !== 422) throw err;
    }
  }
  throw new Error("Someone else is saving at the same time. Please try again.");
}

// ---- Handlers ----

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function listArticles() {
  const { articles } = await readNewsData(BRANCH);
  return json({ articles });
}

// Uploads a file as a git blob only; it is committed with the next Save, so
// abandoned uploads never reach the site.
async function uploadMedia(req) {
  const { filename, contentBase64 } = await req.json();
  if (typeof filename !== "string" || typeof contentBase64 !== "string") {
    return json({ error: "Missing file." }, 400);
  }
  const blob = await (await gh("/git/blobs", {
    method: "POST",
    body: JSON.stringify({ content: contentBase64, encoding: "base64" }),
  })).json();

  const dot = filename.lastIndexOf(".");
  const stem = (dot > 0 ? filename.slice(0, dot) : filename)
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
  const ext = (dot > 0 ? filename.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // A time-based suffix keeps names unique without listing the folder.
  const name = `${stem}-${Date.now().toString(36)}${ext ? "." + ext : ""}`;
  return json({ path: `images/news/${name}`, sha: blob.sha });
}

async function saveArticle(req, editor) {
  const { article: input, media = [] } = await req.json();
  const title = String(input?.title || "").trim();
  const summary = String(input?.summary || "").trim();
  if (!title || !summary) return json({ error: "Title and summary are required." }, 400);

  const fields = {
    title,
    summary,
    tag: String(input.tag || "").trim(),
    thumbnail: String(input.thumbnail || "").trim(),
    content: String(input.content || ""),
  };

  // Only commit uploads the article still uses.
  const used = media.filter((m) =>
    m && MEDIA_PATH.test(m.path) && SHA.test(m.sha) &&
    (fields.thumbnail === m.path || fields.content.includes(m.path))
  );

  const isNew = input.id == null;
  const message = isNew
    ? `News: add "${title}" (via editor, by ${editor})`
    : `News: update "${title}" (via editor, by ${editor})`;

  const saved = await commitNewsChange((articles) => {
    if (isNew) {
      const id = articles.length ? Math.max(...articles.map((a) => a.id)) + 1 : 1;
      const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : new Date().toISOString().slice(0, 10);
      const article = { id, date, ...fields };
      articles.unshift(article);
      return article;
    }
    const article = articles.find((a) => a.id === Number(input.id));
    if (!article) throw Object.assign(new Error("That article no longer exists."), { status: 404 });
    Object.assign(article, fields);
    return article;
  }, used, message);

  return json({ article: saved });
}

export default async (req) => {
  if (!process.env.GITHUB_TOKEN || !process.env.EDITOR_KEYS) {
    return json({ error: "The editor isn't configured yet (missing GITHUB_TOKEN or EDITOR_KEYS)." }, 500);
  }
  const editor = authenticate(req);
  if (!editor) return json({ error: "Wrong password." }, 401);

  const action = new URL(req.url).pathname.split("/").pop();
  try {
    if (req.method === "GET" && action === "articles") return await listArticles();
    if (req.method === "POST" && action === "login") return json({ name: editor });
    if (req.method === "POST" && action === "media") return await uploadMedia(req);
    if (req.method === "POST" && action === "save") return await saveArticle(req, editor);
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: err.message }, err.status === 404 ? 404 : 500);
  }
};

export const config = { path: "/api/news/*" };
