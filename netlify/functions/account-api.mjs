// Accounts for Crispy the Cat: "Log in with Discord" plus cloud saves.
//
// Players without an account keep their per-browser save as before. Logging in
// gives the game a session token; with it the game can store its save here
// and pick it up on any device, along with its mail account (friend code and
// mailbox), so mail follows the player too.
//
// Logging in works without a server inside the game (so the web build can do
// it too), much like signing in to a TV app:
//   1. The game asks for a login: POST /api/account/login. It gets a login id,
//      a poll secret only it knows, a short code to show the player, and a URL.
//   2. The player opens the URL, which sends them to Discord to approve.
//   3. Back here, the page shows the same short code and asks the player to
//      confirm. This stops someone from sending a player a login link that
//      would sign the sender's game in to the player's account.
//   4. Meanwhile the game polls GET /api/account/login/poll until it gets its
//      session token.
//
// Data lives in Firestore next to the mail collections, under the same mail
// server user (see mail-api.mjs and firestore.rules).
//
// Required environment variables (Netlify → Site configuration → Environment variables):
//   DISCORD_CLIENT_ID      From the Discord Developer Portal → your app → OAuth2.
//   DISCORD_CLIENT_SECRET  Same page. Mark it as a secret.
//   MAIL_SERVER_EMAIL, MAIL_SERVER_PASSWORD  Shared with mail-api.mjs.
//   DISCORD_BOT_TOKEN      For supporter tiers; see netlify/lib/supporter.mjs.
// In the Developer Portal, add this redirect: https://steelfishstudios.com/api/account/discord/callback
//
// Endpoints for the game (JSON; the last six need the X-Session header):
//   POST /api/account/login       { return_to? }  → { login_id, poll_secret, code, url, expires_in }
//   GET  /api/account/login/poll?login=…  (X-Login-Secret header)
//                                                 → { status: "pending" } or { status: "done", session, account }
//   GET  /api/account/me                          → { account, save: { revision, updated_unix, summary } | null }
//   GET  /api/account/supporter[?refresh=1]       → { tier, name, in_server, checked_unix }
// "account" includes "supporter" in that same shape.
//   GET  /api/account/save                        → { save, revision, updated_unix, summary } (save is null if none)
//   POST /api/account/save        { save, base_revision, summary? } → { revision, updated_unix }
//                                                   409 { revision, … } if another device saved since base_revision
//   POST /api/account/mail        { player_id?, secret? } → { player_id, secret, friend_code, display_name } or {}
//   POST /api/account/logout                      → { ok: true }
// Pages the player's browser visits:
//   GET  /api/account/discord?login=…             → redirect to Discord
//   GET  /api/account/discord/callback            → confirmation page
//   POST /api/account/discord/confirm             → "you're logged in" (or back to return_to)

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  deleteDoc, doc, getDoc, getFirestore, runTransaction, setDoc, updateDoc,
} from "firebase/firestore";
import { supporterStatus } from "../lib/supporter.mjs";

// Same public web config as news-article.js.
const firebaseConfig = {
  apiKey: "AIzaSyCM7alZkeWOEsNnp5fmza4t_dYdEz2H77M",
  authDomain: "steel-fish-studios.firebaseapp.com",
  projectId: "steel-fish-studios",
  storageBucket: "steel-fish-studios.firebasestorage.app",
  messagingSenderId: "655779279882",
  appId: "1:655779279882:web:587ad0f2ccb8c5ecefdbf3"
};

const SITE = "https://steelfishstudios.com";
const REDIRECT_URI = `${SITE}/api/account/discord/callback`;

const ACCOUNTS = "accounts";            // "discord_<id>" → profile + linked mail account
const LOGINS = "account_logins";        // logins in progress
const SESSIONS = "account_sessions";    // sha256(session token) → account id
const SAVES = "account_saves";          // account id → save text
const MAIL_PLAYERS = "mail_players";    // owned by mail-api.mjs

const LOGIN_TTL_MS = 15 * 60 * 1000;
const MAX_SAVE = 300_000; // characters; Firestore allows ~1 MB per document
// Short code shown in the game and on the confirm page. Same alphabet as
// friend codes, minus look-alikes.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// ---- Firestore ----

const app = initializeApp(firebaseConfig, "accounts");
const auth = getAuth(app);
const db = getFirestore(app);
let signingIn = null;

async function signIn() {
  if (auth.currentUser) return;
  signingIn ??= signInWithEmailAndPassword(
    auth, process.env.MAIL_SERVER_EMAIL, process.env.MAIL_SERVER_PASSWORD,
  ).finally(() => { signingIn = null; });
  await signingIn;
}

// ---- Helpers ----

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Session, X-Login-Secret",
  "Access-Control-Max-Age": "86400",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

function sameString(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req) {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    throw httpError("Invalid JSON.", 400);
  }
}

function shortCode() {
  let code = "";
  for (const b of randomBytes(4)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A small page in the site's colors for the browser half of the login.
function page(title, bodyHtml, status = 200) {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Crispy the Cat</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #3a6479;
         color: #f2f2f2; font: 18px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { background: #213440; border: 2px solid #59808f; border-radius: 12px; padding: 28px;
         max-width: 440px; width: 100%; text-align: center; }
  h1 { font-size: 26px; margin: 0 0 12px; }
  .code { font: bold 40px monospace; letter-spacing: 6px; margin: 12px 0; }
  img { width: 72px; height: 72px; border-radius: 50%; }
  button { font: inherit; border: 0; border-radius: 8px; padding: 10px 22px; margin: 6px; cursor: pointer; }
  .yes { background: #5865f2; color: #fff; } .no { background: #555; color: #fff; }
  p.small { font-size: 14px; color: #bbb; }
</style></head><body><main>${bodyHtml}</main></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function avatarUrl(user) {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
}

async function publicAccount(id, ref, data) {
  return {
    account_id: id,
    provider: "discord",
    discord_id: data.discordId,
    username: data.username,
    display_name: data.globalName || data.username,
    avatar_url: data.avatarUrl,
    supporter: await supporterStatus(ref, data),
  };
}

// Only pages on this site may be returned to after logging in.
function cleanReturnTo(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.origin === SITE ? url.href : "";
  } catch {
    return "";
  }
}

async function loadLogin(id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id ?? ""))) return null;
  const snap = await getDoc(doc(db, LOGINS, id));
  if (!snap.exists()) return null;
  const data = snap.data();
  if (Date.now() - data.createdMs > LOGIN_TTL_MS) {
    await deleteDoc(snap.ref);
    return null;
  }
  return { ref: snap.ref, data };
}

// Returns { id, ref, data } for the session's account, or throws 401.
async function authenticate(req) {
  const token = req.headers.get("x-session") || "";
  if (token.length < 20) throw httpError("Not logged in.", 401);
  const session = await getDoc(doc(db, SESSIONS, sha256hex(token)));
  if (!session.exists()) throw httpError("Not logged in.", 401);
  const id = session.get("accountId");
  const ref = doc(db, ACCOUNTS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw httpError("Not logged in.", 401);
  return { id, ref, data: snap.data(), sessionRef: session.ref };
}

// ---- Login (game side) ----

async function startLogin(req) {
  const body = await readBody(req);
  const loginId = randomUUID();
  const pollSecret = randomBytes(32).toString("base64url");
  const code = shortCode();
  await setDoc(doc(db, LOGINS, loginId), {
    pollSecretHash: sha256hex(pollSecret),
    code,
    status: "pending",
    createdMs: Date.now(),
    returnTo: cleanReturnTo(body.return_to),
    csrf: randomBytes(16).toString("base64url"),
  });
  return json({
    login_id: loginId,
    poll_secret: pollSecret,
    code,
    url: `${SITE}/api/account/discord?login=${loginId}`,
    expires_in: LOGIN_TTL_MS / 1000,
  });
}

async function pollLogin(req) {
  const id = new URL(req.url).searchParams.get("login");
  const login = await loadLogin(id);
  if (!login) return json({ status: "expired" }, 404);
  if (!sameString(sha256hex(req.headers.get("x-login-secret") || ""), login.data.pollSecretHash)) {
    return json({ error: "Not your login." }, 403);
  }
  if (login.data.status === "denied") {
    await deleteDoc(login.ref);
    return json({ status: "denied" });
  }
  if (login.data.status !== "done") return json({ status: "pending" });

  // Handed over exactly once.
  await deleteDoc(login.ref);
  const account = await getDoc(doc(db, ACCOUNTS, login.data.accountId));
  return json({
    status: "done",
    session: login.data.session,
    account: await publicAccount(account.id, account.ref, account.data()),
  });
}

// ---- Login (browser side) ----

async function discordStart(req) {
  const login = await loadLogin(new URL(req.url).searchParams.get("login"));
  if (!login || login.data.status !== "pending") {
    return page("Link expired", "<h1>This login link has expired</h1><p>Go back to the game and try logging in again.</p>", 410);
  }
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: "identify",
    state: login.ref.id,
  });
  return Response.redirect(url.href, 302);
}

async function discordCallback(req) {
  const params = new URL(req.url).searchParams;
  const login = await loadLogin(params.get("state"));
  if (!login || login.data.status !== "pending") {
    return page("Link expired", "<h1>This login link has expired</h1><p>Go back to the game and try logging in again.</p>", 410);
  }
  if (!params.get("code")) {
    // The player pressed Cancel on Discord's screen.
    await updateDoc(login.ref, { status: "denied" });
    return page("Cancelled", "<h1>Login cancelled</h1><p>You can close this tab.</p>");
  }

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: params.get("code"),
      redirect_uri: REDIRECT_URI,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!token.access_token) {
    console.error("Discord token exchange failed", tokenRes.status, token.error);
    return page("Something went wrong", "<h1>Discord didn't let us in</h1><p>Go back to the game and try again.</p>", 502);
  }
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!user.id) {
    return page("Something went wrong", "<h1>Couldn't read your Discord account</h1><p>Go back to the game and try again.</p>", 502);
  }

  const discord = {
    id: String(user.id),
    username: String(user.username ?? ""),
    globalName: String(user.global_name ?? ""),
    avatarUrl: avatarUrl(user),
  };
  await updateDoc(login.ref, { status: "confirm", discord });

  const name = discord.globalName || discord.username;
  return page("Confirm login", `
    <img src="${escapeHtml(discord.avatarUrl)}" alt="">
    <h1>Log in as ${escapeHtml(name)}?</h1>
    <p>Only continue if Crispy the Cat is showing this code:</p>
    <div class="code">${escapeHtml(login.data.code)}</div>
    <form method="post" action="/api/account/discord/confirm">
      <input type="hidden" name="login" value="${escapeHtml(login.ref.id)}">
      <input type="hidden" name="csrf" value="${escapeHtml(login.data.csrf)}">
      <button class="yes" name="answer" value="yes">Yes, log in</button>
      <button class="no" name="answer" value="no">No</button>
    </form>
    <p class="small">If you didn't start this login, press No.</p>`);
}

async function discordConfirm(req) {
  const form = await req.formData().catch(() => null);
  const login = await loadLogin(form?.get("login"));
  if (!login || login.data.status !== "confirm" || !sameString(form.get("csrf"), login.data.csrf)) {
    return page("Link expired", "<h1>This login link has expired</h1><p>Go back to the game and try logging in again.</p>", 410);
  }
  if (form.get("answer") !== "yes") {
    await updateDoc(login.ref, { status: "denied" });
    return page("Cancelled", "<h1>Login cancelled</h1><p>You can close this tab.</p>");
  }

  const { discord } = login.data;
  const accountId = `discord_${discord.id}`;
  const accountRef = doc(db, ACCOUNTS, accountId);
  const session = randomBytes(32).toString("base64url");
  await runTransaction(db, async (tx) => {
    const existing = await tx.get(accountRef);
    const profile = {
      provider: "discord",
      discordId: discord.id,
      username: discord.username,
      globalName: discord.globalName,
      avatarUrl: discord.avatarUrl,
      lastLoginMs: Date.now(),
    };
    if (existing.exists()) tx.update(accountRef, profile);
    else tx.set(accountRef, { ...profile, createdMs: Date.now() });
    tx.set(doc(db, SESSIONS, sha256hex(session)), { accountId, createdMs: Date.now() });
    tx.update(login.ref, { status: "done", accountId, session });
  });

  if (login.data.returnTo) return Response.redirect(login.data.returnTo, 303);
  return page("Logged in", `
    <img src="${escapeHtml(discord.avatarUrl)}" alt="">
    <h1>You're logged in!</h1>
    <p>Go back to Crispy the Cat. You can close this tab.</p>`);
}

// ---- Account (game side, needs a session) ----

function saveMeta(snap) {
  if (!snap.exists()) return null;
  return {
    revision: snap.get("revision"),
    updated_unix: snap.get("updatedMs") / 1000,
    summary: snap.get("summary") || {},
  };
}

async function me(account) {
  const save = await getDoc(doc(db, SAVES, account.id));
  return json({ account: await publicAccount(account.id, account.ref, account.data), save: saveMeta(save) });
}

// With ?refresh=1, asks Discord again (at most once a minute), e.g. right
// after the player backs us.
async function supporter(req, account) {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  return json(await supporterStatus(account.ref, account.data, { force }));
}

async function getSave(account) {
  const snap = await getDoc(doc(db, SAVES, account.id));
  if (!snap.exists()) return json({ save: null, revision: 0, updated_unix: 0, summary: {} });
  return json({ save: snap.get("data"), ...saveMeta(snap) });
}

// Small numbers the game shows when choosing between saves, e.g. Kitcoins.
function cleanSummary(value) {
  const out = {};
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value).slice(0, 10)) {
      if (/^[a-z_]{1,24}$/.test(k) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

// Revisions stop two devices from silently overwriting each other: a write
// only lands if it was based on the latest cloud save.
async function putSave(req, account) {
  const body = await readBody(req);
  if (typeof body.save !== "string" || !body.save) return json({ error: "No save sent." }, 400);
  if (body.save.length > MAX_SAVE) return json({ error: "That save is too big." }, 413);
  const base = Number(body.base_revision) || 0;
  const ref = doc(db, SAVES, account.id);

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? snap.get("revision") : 0;
    if (current !== base) return { conflict: true, meta: saveMeta(snap) };
    const updatedMs = Date.now();
    tx.set(ref, { data: body.save, revision: current + 1, updatedMs, summary: cleanSummary(body.summary) });
    return { revision: current + 1, updated_unix: updatedMs / 1000 };
  });
  if (result.conflict) return json({ error: "Another device saved first.", ...result.meta }, 409);
  return json(result);
}

// Ties a mail account to this account, so the friend code and mailbox follow
// the player between devices. If the account already has one, that one wins
// and the device switches to it; otherwise the device's own is linked.
async function linkMail(req, account) {
  const body = await readBody(req);
  const linked = account.data.mail;
  if (linked?.playerId) {
    const player = await getDoc(doc(db, MAIL_PLAYERS, linked.playerId));
    if (player.exists()) {
      return json({
        player_id: linked.playerId,
        secret: linked.secret,
        friend_code: player.get("friendCode"),
        display_name: player.get("displayName") || "",
      });
    }
  }

  const playerId = String(body.player_id ?? "");
  const secret = String(body.secret ?? "");
  if (!/^[0-9a-f-]{36}$/.test(playerId) || !secret) return json({});
  const player = await getDoc(doc(db, MAIL_PLAYERS, playerId));
  if (!player.exists() || !sameString(sha256hex(secret), player.get("secretHash"))) return json({});
  if (player.get("accountId") && player.get("accountId") !== account.id) return json({});

  await updateDoc(account.ref, { mail: { playerId, secret } });
  await updateDoc(player.ref, { accountId: account.id });
  return json({
    player_id: playerId,
    secret,
    friend_code: player.get("friendCode"),
    display_name: player.get("displayName") || "",
  });
}

async function logout(account) {
  await deleteDoc(account.sessionRef);
  return json({ ok: true });
}

// ---- Routing ----

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const missing = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "MAIL_SERVER_EMAIL", "MAIL_SERVER_PASSWORD"]
    .filter((k) => !process.env[k]);
  if (missing.length) return json({ error: `Accounts aren't configured yet (missing ${missing.join(", ")}).` }, 500);

  const path = new URL(req.url).pathname.replace(/^\/api\/account\/?/, "").replace(/\/$/, "");
  const route = `${req.method} ${path}`;
  try {
    await signIn();
    switch (route) {
      case "POST login": return await startLogin(req);
      case "GET login/poll": return await pollLogin(req);
      case "GET discord": return await discordStart(req);
      case "GET discord/callback": return await discordCallback(req);
      case "POST discord/confirm": return await discordConfirm(req);
    }
    const routes = {
      "GET me": (account) => me(account),
      "GET supporter": (account) => supporter(req, account),
      "GET save": (account) => getSave(account),
      "POST save": (account) => putSave(req, account),
      "POST mail": (account) => linkMail(req, account),
      "POST logout": (account) => logout(account),
    };
    if (!routes[route]) return json({ error: "Not found." }, 404);
    return await routes[route](await authenticate(req));
  } catch (err) {
    if (err.status && err.status < 500) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config = { path: "/api/account/*" };
