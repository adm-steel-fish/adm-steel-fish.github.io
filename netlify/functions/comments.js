import { getStore } from "@netlify/blobs";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: HEADERS });
  }

  const url = new URL(req.url);
  const articleId = url.searchParams.get("id");

  if (!articleId || isNaN(parseInt(articleId, 10))) {
    return new Response(JSON.stringify({ error: "Missing or invalid id" }), {
      status: 400,
      headers: HEADERS,
    });
  }

  const store = getStore("comments");
  const key = `article-${articleId}`;

  if (req.method === "GET") {
    const comments = (await store.get(key, { type: "json" })) ?? [];
    return new Response(JSON.stringify(comments), { status: 200, headers: HEADERS });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: HEADERS,
      });
    }

    const name = String(body.name ?? "").trim() || "Anonymous";
    const text = String(body.text ?? "").trim();

    if (!text) {
      return new Response(JSON.stringify({ error: "Comment text is required" }), {
        status: 400,
        headers: HEADERS,
      });
    }

    if (name.length > 80 || text.length > 2000) {
      return new Response(JSON.stringify({ error: "Input too long" }), {
        status: 400,
        headers: HEADERS,
      });
    }

    const existing = (await store.get(key, { type: "json" })) ?? [];
    const updated = [
      ...existing,
      { name, text, datetime: new Date().toISOString() },
    ];
    await store.set(key, JSON.stringify(updated));
    return new Response(JSON.stringify(updated), { status: 200, headers: HEADERS });
  }

  return new Response("Method not allowed", { status: 405, headers: HEADERS });
};

export const config = { path: "/api/comments" };
