// Steel Fish Studios accounts: log in with Google or Discord, on the website or
// in Crispy the Cat, plus cloud saves for the game.
//
// One account can have both a Google and a Discord login linked to it. Each
// login (an "identity") points at its account in account_identities, so either
// one opens the same account. Accounts made before linking existed have the id
// "discord_<id>" and no identity document; findAccount() still finds those.
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
//   2. The player opens the URL, which sends them to Google or Discord to approve.
//   3. Back here, the page shows the same short code and asks the player to
//      confirm. This stops someone from sending a player a login link that
//      would sign the sender's game in to the player's account.
//   4. Meanwhile the game polls GET /api/account/login/poll until it gets its
//      session token.
//
// The website keeps its session in an HttpOnly cookie instead (see "Website").
//
// Data lives in Firestore next to the mail collections, under the same mail
// server user (see mail-api.mjs and firestore.rules).
//
// Required environment variables (Netlify → Site configuration → Environment variables):
//   DISCORD_CLIENT_ID      From the Discord Developer Portal → your app → OAuth2.
//   DISCORD_CLIENT_SECRET  Same page. Mark it as a secret.
//   MAIL_SERVER_EMAIL, MAIL_SERVER_PASSWORD  Shared with mail-api.mjs.
//   DISCORD_BOT_TOKEN      For supporter tiers; see netlify/lib/supporter.mjs.
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//                          Google Cloud Console (steel-fish-studios project) →
//                          APIs & Services → Credentials → OAuth client ID,
//                          type "Web application". Mark the secret as a secret.
// In the Discord Developer Portal, add this redirect: https://steelfishstudios.com/api/account/discord/callback
// In the Google OAuth client, add this redirect:    https://steelfishstudios.com/api/account/google/callback
//
// Endpoints for the game (JSON; the ones after poll need the X-Session header):
//   POST /api/account/login       { provider?, return_to?, game? } → { login_id, poll_secret, code, url, expires_in }
//                                                   game (e.g. "jelly-fight") names the game on the login pages
//   GET  /api/account/login/poll?login=…  (X-Login-Secret header)
//                                                 → { status: "pending" } or { status: "done", session, account }
//   GET  /api/account/me                          → { account, save: { revision, updated_unix, summary } | null }
//   GET  /api/account/supporter[?refresh=1]       → { tier, name, in_server, checked_unix }
// "account" includes "supporter" in that same shape, and "logins":
// { google: { email, name } | null, discord: { username, display_name, avatar_url } | null }.
// The two save endpoints take ?game=<id> for games other than Crispy the Cat
// (e.g. ?game=photomaze); each game keeps its own save.
//   GET  /api/account/save                        → { save, revision, updated_unix, summary } (save is null if none)
//   POST /api/account/save        { save, base_revision, summary? } → { revision, updated_unix }
//                                                   409 { revision, … } if another device saved since base_revision
//   POST /api/account/mail        { player_id?, secret? } → { player_id, secret, friend_code, display_name } or {}
//   POST /api/account/logout                      → { ok: true }
// Leaderboards, one per game in LEADERBOARD_GAMES (?game=<id>). Both need a
// login: only account holders can publish a score or see the board.
//   GET  /api/account/leaderboard[?limit=20]      → { scores: [{ rank, name, score, mine }], me: { rank, name, score } | null }
//   POST /api/account/leaderboard { name, score } → { name, score, improved }  (keeps the account's best score)
//   POST /api/account/unlink      { provider }    → { account }  (only while another login stays linked)
// Pages the player's browser visits:
//   GET  /api/account/{google|discord}?login=…    → redirect to Google or Discord
//   GET  /api/account/{google|discord}/callback   → confirmation page (game) or redirect (website)
//   POST /api/account/confirm                     → "you're logged in" (or back to return_to)
// Website (the endpoints above work with the sfs_session cookie instead of
// X-Session; POSTs must come from a page on this site):
//   GET  /api/account/web/login/{google|discord}?return_to=…  → log in, or sign up on first visit
//   GET  /api/account/web/link/{google|discord}?return_to=…   → add that login to this account
//   Both come back to return_to (default /account.html) with ?auth=ok, ?auth=linked&provider=…
//   or ?auth=error&reason=(expired|cancelled|provider|taken|has_other|login_first) added.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection, deleteDoc, deleteField, doc, getCountFromServer, getDoc, getDocs, getFirestore,
  limit, orderBy, query, runTransaction, setDoc, updateDoc, where,
} from "firebase/firestore";
import { supporterStatus } from "../lib/supporter.mjs";
import { findBlockedWord } from "../lib/mail-word-filter.mjs";

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
const GOOGLE_REDIRECT_URI = `${SITE}/api/account/google/callback`;

const ACCOUNTS = "accounts";             // account id → profile + linked mail account
const IDENTITIES = "account_identities"; // "<provider>_<provider's user id>" → account id
const LOGINS = "account_logins";         // logins in progress
const SESSIONS = "account_sessions";     // sha256(session token) → account id
const SAVES = "account_saves";           // account id (Crispy) or "<account id>__<game>" → save text
const MAIL_PLAYERS = "mail_players";     // owned by mail-api.mjs
const LEADERBOARDS = "leaderboards";     // leaderboards/<game>/scores/<account id> → name + best score

// Games with a leaderboard. maxScore turns away scores no run could reach;
// the game itself reports its score, so this is the only check there is.
const LEADERBOARD_GAMES = {
  "jelly-fight": { maxScore: 9_999_999 },
};
const BOARD_NAME_MAX = 12;
// What the login pages call the game that asked for the login.
const GAME_NAMES = { "jelly-fight": "Jelly Fight!" };
const DEFAULT_GAME_NAME = "Crispy the Cat";

const PROVIDERS = ["google", "discord"];
const LOGIN_TTL_MS = 15 * 60 * 1000;
const WEB_SESSION_MS = 60 * 24 * 60 * 60 * 1000; // website logins last 60 days
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

function json(body, status = 200, cookies = []) {
  const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

// Response.redirect() can't carry cookies, so this builds one by hand.
function redirect(url, cookies = []) {
  const headers = new Headers({ Location: url, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
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

// A small page in the site's colors for the browser half of the game's login.
function page(title, bodyHtml, status = 200) {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - Steel Fish Studios</title>
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

function displayName(data) {
  return data.globalName || data.username || data.google?.name || "Player";
}

async function publicAccount(id, ref, data) {
  return {
    account_id: id,
    provider: data.discordId ? "discord" : "google",
    discord_id: data.discordId || null,
    username: data.username || "",
    display_name: displayName(data),
    avatar_url: data.avatarUrl || data.google?.picture || "",
    logins: {
      google: data.google?.sub ? { email: data.google.email || "", name: data.google.name || "" } : null,
      discord: data.discordId
        ? { username: data.username, display_name: data.globalName || data.username, avatar_url: data.avatarUrl }
        : null,
    },
    supporter: await supporterStatus(ref, data),
  };
}

// Only pages on this site may be returned to after logging in.
function cleanReturnTo(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value), SITE);
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

// ---- Sessions ----

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// sfs_session  The website's session token. HttpOnly, only sent to /api/account.
// sfs_oauth    Ties a Google/Discord round trip to the browser that began it,
//              so nobody can trick a visitor into logging in to someone else's
//              account.
// sfs_user     The display name, readable by the site's pages so the menu can
//              say who's logged in without calling the API on every page view.
//              It grants nothing.
const COOKIE_FLAGS = "Secure; SameSite=Lax";
const sessionCookie = (token) =>
  `sfs_session=${token}; Path=/api/account; HttpOnly; ${COOKIE_FLAGS}; Max-Age=${WEB_SESSION_MS / 1000}`;
const userCookie = (name) =>
  `sfs_user=${encodeURIComponent(name)}; Path=/; ${COOKIE_FLAGS}; Max-Age=${WEB_SESSION_MS / 1000}`;
const oauthCookie = (nonce) =>
  `sfs_oauth=${nonce}; Path=/api/account; HttpOnly; ${COOKIE_FLAGS}; Max-Age=${LOGIN_TTL_MS / 1000}`;
const CLEAR_SESSION = [
  `sfs_session=; Path=/api/account; HttpOnly; ${COOKIE_FLAGS}; Max-Age=0`,
  `sfs_user=; Path=/; ${COOKIE_FLAGS}; Max-Age=0`,
];
const CLEAR_OAUTH = `sfs_oauth=; Path=/api/account; HttpOnly; ${COOKIE_FLAGS}; Max-Age=0`;

// Returns { id, ref, data, sessionRef, viaCookie } for the session's account,
// or throws 401. The game sends X-Session; the website sends the cookie.
async function authenticate(req) {
  const header = req.headers.get("x-session") || "";
  const token = header || readCookies(req).sfs_session || "";
  if (token.length < 20) throw httpError("Not logged in.", 401);
  const session = await getDoc(doc(db, SESSIONS, sha256hex(token)));
  if (!session.exists()) throw httpError("Not logged in.", 401);
  if (session.get("kind") === "web" && Date.now() - session.get("createdMs") > WEB_SESSION_MS) {
    await deleteDoc(session.ref);
    throw httpError("Not logged in.", 401);
  }
  const id = session.get("accountId");
  const ref = doc(db, ACCOUNTS, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw httpError("Not logged in.", 401);
  return { id, ref, data: snap.data(), sessionRef: session.ref, viaCookie: !header };
}

// ---- Identities: which Google/Discord login opens which account ----

const identityRef = (provider, providerId) => doc(db, IDENTITIES, `${provider}_${providerId}`);

// The account fields each provider fills in. Discord's stay at the top level,
// where the game and supporter.mjs already look for them.
function providerFields(provider, p) {
  if (provider === "discord") {
    return { discordId: p.id, username: p.username, globalName: p.globalName, avatarUrl: p.avatarUrl };
  }
  return { google: { sub: p.id, email: p.email, name: p.name, picture: p.picture } };
}

function unlinkFields(provider) {
  if (provider === "discord") {
    return {
      discordId: deleteField(), username: deleteField(), globalName: deleteField(),
      avatarUrl: deleteField(), supporter: deleteField(),
    };
  }
  return { google: deleteField() };
}

const linkedId = (data, provider) => (provider === "discord" ? data.discordId : data.google?.sub) || null;
const linkedProviders = (data) => PROVIDERS.filter((p) => linkedId(data, p));

// The id of the account this login opens, or null. Only reads, so it must run
// before any writes in tx.
async function findAccount(tx, provider, providerId) {
  const identity = await tx.get(identityRef(provider, providerId));
  if (identity.exists()) return identity.get("accountId");
  if (provider === "discord") {
    // Accounts from before linking existed.
    const legacy = await tx.get(doc(db, ACCOUNTS, `discord_${providerId}`));
    if (legacy.exists() && legacy.get("discordId") === providerId) return legacy.id;
  }
  return null;
}

// Logs in with a Google/Discord profile, making the account on first login.
// Returns { accountId, session, data }. extra(tx, accountId, session) may add
// writes to the same transaction.
async function loginWith(provider, profile, { web = false, extra } = {}) {
  const session = randomBytes(32).toString("base64url");
  return runTransaction(db, async (tx) => {
    const found = await findAccount(tx, provider, profile.id);
    const accountId = found || `acct_${randomUUID()}`;
    const accountRef = doc(db, ACCOUNTS, accountId);
    const existing = found ? await tx.get(accountRef) : null;
    const now = Date.now();
    const fields = { ...providerFields(provider, profile), lastLoginMs: now };
    let data;
    if (existing?.exists()) {
      tx.update(accountRef, fields);
      data = { ...existing.data(), ...fields };
    } else {
      data = { ...fields, createdMs: now };
      tx.set(accountRef, data);
    }
    tx.set(identityRef(provider, profile.id), { accountId, provider, providerId: profile.id, linkedMs: now });
    tx.set(doc(db, SESSIONS, sha256hex(session)), { accountId, createdMs: now, ...(web ? { kind: "web" } : {}) });
    extra?.(tx, accountId, session);
    return { accountId, session, data };
  });
}

// Adds a Google/Discord login to an account. Returns null when done, or why
// not: "taken" (that login already opens a different account), "has_other"
// (this account already has another login from that provider) or "gone".
async function linkTo(accountId, provider, profile) {
  return runTransaction(db, async (tx) => {
    const owner = await findAccount(tx, provider, profile.id);
    const accountRef = doc(db, ACCOUNTS, accountId);
    const account = await tx.get(accountRef);
    if (!account.exists()) return "gone";
    if (owner && owner !== accountId) return "taken";
    const current = linkedId(account.data(), provider);
    if (current && current !== profile.id) return "has_other";
    tx.update(accountRef, providerFields(provider, profile));
    tx.set(identityRef(provider, profile.id), { accountId, provider, providerId: profile.id, linkedMs: Date.now() });
    return null;
  });
}

async function unlink(req, account) {
  const { provider } = await readBody(req);
  if (!PROVIDERS.includes(provider)) return json({ error: "Unknown login." }, 400);
  const linked = linkedProviders(account.data);
  if (!linked.includes(provider)) return json({ error: "That login isn't linked." }, 400);
  if (linked.length < 2) {
    return json({ error: "That's your only way to log in. Link another one first." }, 400);
  }
  const providerId = linkedId(account.data, provider);
  await runTransaction(db, async (tx) => {
    const identity = await tx.get(identityRef(provider, providerId));
    if (identity.exists() && identity.get("accountId") === account.id) tx.delete(identity.ref);
    tx.update(account.ref, unlinkFields(provider));
  });
  const snap = await getDoc(account.ref);
  return json({ account: await publicAccount(account.id, account.ref, snap.data()) });
}

// ---- Provider profiles ----

// Trades Discord's ?code= for { id, username, globalName, avatarUrl }, or null.
async function discordProfile(code) {
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!token.access_token) {
    console.error("Discord token exchange failed", tokenRes.status, token.error);
    return null;
  }
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!user.id) return null;
  return {
    id: String(user.id),
    username: String(user.username ?? ""),
    globalName: String(user.global_name ?? ""),
    avatarUrl: avatarUrl(user),
  };
}

// Trades Google's ?code= for { id, email, name, picture }, or null.
async function googleProfile(code) {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: GOOGLE_REDIRECT_URI,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!token.access_token) {
    console.error("Google token exchange failed", tokenRes.status, token.error);
    return null;
  }
  const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!user.sub) return null;
  return {
    id: String(user.sub),
    email: user.email_verified ? String(user.email ?? "") : "",
    name: String(user.name ?? ""),
    picture: String(user.picture ?? ""),
  };
}

// ---- Login (game side) ----

// body.provider picks "google" or "discord". Game builds from before Google
// existed send none, and get Discord as they always have.
async function startLogin(req) {
  const body = await readBody(req);
  const provider = body.provider === "google" ? "google" : "discord";
  if (provider === "google" && !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
    return json({ error: "Logging in with Google isn't available yet. Please use Discord." }, 503);
  }
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
    ...(Object.hasOwn(GAME_NAMES, body.game) ? { game: body.game } : {}),
  });
  return json({
    login_id: loginId,
    poll_secret: pollSecret,
    code,
    url: `${SITE}/api/account/${provider}?login=${loginId}`,
    expires_in: LOGIN_TTL_MS / 1000,
  });
}

async function pollLogin(req) {
  const id = new URL(req.url).searchParams.get("login");
  const login = await loadLogin(id);
  if (!login || login.data.kind === "web") return json({ status: "expired" }, 404);
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

// ---- Login (game, browser side) ----

const expiredPage = () =>
  page("Link expired", "<h1>This login link has expired</h1><p>Go back to the game and try logging in again.</p>", 410);

const PROVIDER_NAMES = { google: "Google", discord: "Discord" };

// The game a login was started from, for the pages the player reads.
const loginGameName = (login) => GAME_NAMES[login.data.game] || DEFAULT_GAME_NAME;

// Where the player approves the login on Google's or Discord's own site.
function authorizeUrl(provider, state) {
  const url = provider === "google"
    ? new URL("https://accounts.google.com/o/oauth2/v2/auth")
    : new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams(provider === "google"
    ? {
      client_id: process.env.GOOGLE_CLIENT_ID,
      response_type: "code",
      redirect_uri: GOOGLE_REDIRECT_URI,
      scope: "openid email profile",
      state,
      prompt: "select_account",
    }
    : {
      client_id: process.env.DISCORD_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: "identify",
      state,
    });
  return url.href;
}

const profileName = (provider, p) =>
  provider === "google" ? p.name || p.email || "your Google account" : p.globalName || p.username;
const profilePicture = (provider, p) => (provider === "google" ? p.picture : p.avatarUrl);

function avatarImg(src) {
  return src ? `<img src="${escapeHtml(src)}" alt="" referrerpolicy="no-referrer">` : "";
}

// GET /api/account/{google|discord}?login=… : the link the game opens.
async function gameStart(req, provider) {
  const login = await loadLogin(new URL(req.url).searchParams.get("login"));
  if (!login || login.data.kind === "web" || login.data.status !== "pending") return expiredPage();
  return Response.redirect(authorizeUrl(provider, login.ref.id), 302);
}

// Back from Google/Discord during a game login: ask the player to check the
// code before the game gets the account.
async function gameCallback(req, login, provider) {
  const params = new URL(req.url).searchParams;
  if (login.data.status !== "pending") return expiredPage();
  const name = PROVIDER_NAMES[provider];
  if (!params.get("code")) {
    // The player pressed Cancel on Google's or Discord's screen.
    await updateDoc(login.ref, { status: "denied" });
    return page("Cancelled", "<h1>Login cancelled</h1><p>You can close this tab.</p>");
  }

  const profile = provider === "google"
    ? await googleProfile(params.get("code"))
    : await discordProfile(params.get("code"));
  if (!profile) {
    return page("Something went wrong", `<h1>${name} didn't let us in</h1><p>Go back to the game and try again.</p>`, 502);
  }
  await updateDoc(login.ref, { status: "confirm", provider, profile });

  return page("Confirm login", `
    ${avatarImg(profilePicture(provider, profile))}
    <h1>Log in as ${escapeHtml(profileName(provider, profile))}?</h1>
    <p>Only continue if ${escapeHtml(loginGameName(login))} is showing this code:</p>
    <div class="code">${escapeHtml(login.data.code)}</div>
    <form method="post" action="/api/account/confirm">
      <input type="hidden" name="login" value="${escapeHtml(login.ref.id)}">
      <input type="hidden" name="csrf" value="${escapeHtml(login.data.csrf)}">
      <button class="yes" name="answer" value="yes">Yes, log in</button>
      <button class="no" name="answer" value="no">No</button>
    </form>
    <p class="small">If you didn't start this login, press No.</p>`);
}

// Google and Discord each have one redirect URL, shared by the game's logins
// and the website's.
async function providerCallback(req, provider) {
  const login = await loadLogin(new URL(req.url).searchParams.get("state"));
  if (login?.data.kind === "web") return webCallback(req, login, provider);
  if (!login) {
    if (provider === "google") {
      // Most Google logins come from the website, so send expired ones back there.
      return redirect(webReturn("", { auth: "error", reason: "expired" }), [CLEAR_OAUTH]);
    }
    return expiredPage();
  }
  return gameCallback(req, login, provider);
}

async function gameConfirm(req) {
  const form = await req.formData().catch(() => null);
  const login = await loadLogin(form?.get("login"));
  if (!login || login.data.status !== "confirm" || !sameString(form.get("csrf"), login.data.csrf)) {
    return expiredPage();
  }
  if (form.get("answer") !== "yes") {
    await updateDoc(login.ref, { status: "denied" });
    return page("Cancelled", "<h1>Login cancelled</h1><p>You can close this tab.</p>");
  }

  // Logins started before Google existed kept the profile under "discord".
  const provider = login.data.provider || "discord";
  const profile = login.data.profile || login.data.discord;
  await loginWith(provider, profile, {
    extra: (tx, accountId, session) => tx.update(login.ref, { status: "done", accountId, session }),
  });

  if (login.data.returnTo) return Response.redirect(login.data.returnTo, 303);
  return page("Logged in", `
    ${avatarImg(profilePicture(provider, profile))}
    <h1>You're logged in!</h1>
    <p>Go back to ${escapeHtml(loginGameName(login))}. You can close this tab.</p>`);
}

// ---- Website ----
//
// The same Google/Discord round trip as the game's, minus the short code: the
// browser that starts it gets an sfs_oauth cookie, and the callback only
// finishes for that browser.

function webReturn(returnTo, params) {
  const url = new URL(returnTo || `${SITE}/account.html`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

async function webStart(req, mode, provider) {
  if (!PROVIDERS.includes(provider)) return json({ error: "Not found." }, 404);
  const returnTo = cleanReturnTo(new URL(req.url).searchParams.get("return_to")) || `${SITE}/account.html`;
  let accountId = null;
  if (mode === "link") {
    const account = await authenticate(req).catch(() => null);
    if (!account) return redirect(webReturn(returnTo, { auth: "error", reason: "login_first" }));
    accountId = account.id;
  }

  const loginId = randomUUID();
  const nonce = randomBytes(24).toString("base64url");
  await setDoc(doc(db, LOGINS, loginId), {
    kind: "web", mode, provider, accountId, returnTo,
    nonceHash: sha256hex(nonce), createdMs: Date.now(),
  });

  return redirect(authorizeUrl(provider, loginId), [oauthCookie(nonce)]);
}

async function webCallback(req, login, provider) {
  const params = new URL(req.url).searchParams;
  const { mode, accountId, returnTo, nonceHash } = login.data;
  await deleteDoc(login.ref); // single use, whatever happens next
  const fail = (reason) => redirect(webReturn(returnTo, { auth: "error", reason }), [CLEAR_OAUTH]);

  if (login.data.provider !== provider) return fail("expired");
  if (!sameString(sha256hex(readCookies(req).sfs_oauth || ""), nonceHash)) return fail("expired");
  if (!params.get("code")) return fail("cancelled");

  const profile = provider === "google"
    ? await googleProfile(params.get("code"))
    : await discordProfile(params.get("code"));
  if (!profile) return fail("provider");

  if (mode === "link") {
    const problem = await linkTo(accountId, provider, profile);
    if (problem) return fail(problem === "gone" ? "login_first" : problem);
    return redirect(webReturn(returnTo, { auth: "linked", provider }), [CLEAR_OAUTH]);
  }

  const { session, data } = await loginWith(provider, profile, { web: true });
  return redirect(webReturn(returnTo, { auth: "ok" }),
    [CLEAR_OAUTH, sessionCookie(session), userCookie(displayName(data))]);
}

// ---- Account (needs a session) ----

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
  return json(
    { account: await publicAccount(account.id, account.ref, account.data), save: saveMeta(save) },
    200,
    account.viaCookie ? [userCookie(displayName(account.data))] : [],
  );
}

// With ?refresh=1, asks Discord again (at most once a minute), e.g. right
// after the player backs us.
async function supporter(req, account) {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  return json(await supporterStatus(account.ref, account.data, { force }));
}

// Each game has its own save, picked with ?game=<id>. Crispy the Cat's came
// first and has no id: it lives under the bare account id.
function saveRef(req, account) {
  const game = new URL(req.url).searchParams.get("game") || "";
  if (!game) return doc(db, SAVES, account.id);
  if (!/^[a-z0-9-]{1,32}$/.test(game)) throw httpError("Unknown game.", 400);
  return doc(db, SAVES, `${account.id}__${game}`);
}

async function getSave(req, account) {
  const snap = await getDoc(saveRef(req, account));
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
  const ref = saveRef(req, account);

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

// ---- Leaderboards ----

function leaderboardGame(req) {
  const game = new URL(req.url).searchParams.get("game") || "";
  if (!Object.hasOwn(LEADERBOARD_GAMES, game)) throw httpError("Unknown game.", 400);
  return game;
}

const boardScores = (game) => collection(db, LEADERBOARDS, game, "scores");

// Names are drawn with the games' own pixel letters, so only what those can
// show is kept: lower case letters, digits, spaces and hyphens. Jelly Fight!
// cleans names the same way (PersonalLeaderboard.clean_name).
function cleanBoardName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ +/g, " ")
    .trim().slice(0, BOARD_NAME_MAX).trim();
}

// Players ahead of this score, plus one. Null if the count can't be had.
async function boardRank(game, score) {
  try {
    const ahead = await getCountFromServer(query(boardScores(game), where("score", ">", score)));
    return ahead.data().count + 1;
  } catch (err) {
    console.error("Leaderboard rank failed", err);
    return null;
  }
}

async function getLeaderboard(req, account) {
  const game = leaderboardGame(req);
  const asked = Math.floor(Number(new URL(req.url).searchParams.get("limit"))) || 20;
  const top = await getDocs(query(boardScores(game), orderBy("score", "desc"), limit(Math.min(Math.max(asked, 1), 100))));
  const scores = top.docs.map((d, i) => ({
    rank: i + 1, name: d.get("name"), score: d.get("score"), mine: d.id === account.id,
  }));

  let me = scores.find((s) => s.mine) || null;
  if (me) {
    me = { rank: me.rank, name: me.name, score: me.score };
  } else {
    const own = await getDoc(doc(boardScores(game), account.id));
    if (own.exists()) {
      me = { rank: await boardRank(game, own.get("score")), name: own.get("name"), score: own.get("score") };
    }
  }
  return json({ scores, me });
}

// One entry per account, holding its best score. A lower score changes
// nothing but the name.
async function postLeaderboard(req, account) {
  const game = leaderboardGame(req);
  const body = await readBody(req);
  const score = body.score;
  if (!Number.isInteger(score) || score < 1 || score > LEADERBOARD_GAMES[game].maxScore) {
    return json({ error: "That score can't be submitted." }, 400);
  }

  let name = cleanBoardName(body.name);
  if (name && findBlockedWord(name)) return json({ error: "Please pick another name." }, 400);
  if (!name) {
    name = cleanBoardName(displayName(account.data));
    if (!name || findBlockedWord(name)) name = "player";
  }

  const ref = doc(boardScores(game), account.id);
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const previous = snap.exists() ? snap.get("score") : 0;
    const improved = score > previous;
    const best = Math.max(score, previous);
    tx.set(ref, { name, score: best, updatedMs: Date.now() });
    return { name, score: best, improved };
  });
  return json(result);
}

async function logout(account) {
  await deleteDoc(account.sessionRef);
  return json({ ok: true }, 200, account.viaCookie ? CLEAR_SESSION : []);
}

// ---- Routing ----

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const missing = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "MAIL_SERVER_EMAIL", "MAIL_SERVER_PASSWORD"]
    .filter((k) => !process.env[k]);
  if (missing.length) return json({ error: `Accounts aren't configured yet (missing ${missing.join(", ")}).` }, 500);

  const path = new URL(req.url).pathname.replace(/^\/api\/account\/?/, "").replace(/\/$/, "");
  const route = `${req.method} ${path}`;
  if (/(^|\/)google(\/|$)/.test(path) && !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
    return json({ error: "Google login isn't configured yet (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)." }, 500);
  }
  try {
    await signIn();
    const web = path.match(/^web\/(login|link)\/([a-z]+)$/);
    if (req.method === "GET" && web) return await webStart(req, web[1], web[2]);
    switch (route) {
      case "POST login": return await startLogin(req);
      case "GET login/poll": return await pollLogin(req);
      case "GET discord": return await gameStart(req, "discord");
      case "GET google": return await gameStart(req, "google");
      case "GET discord/callback": return await providerCallback(req, "discord");
      case "POST confirm":
      case "POST discord/confirm": return await gameConfirm(req); // the old address, for pages already open
      case "GET google/callback": return await providerCallback(req, "google");
    }
    const routes = {
      "GET me": (account) => me(account),
      "GET supporter": (account) => supporter(req, account),
      "GET save": (account) => getSave(req, account),
      "POST save": (account) => putSave(req, account),
      "POST mail": (account) => linkMail(req, account),
      "POST logout": (account) => logout(account),
      "GET leaderboard": (account) => getLeaderboard(req, account),
      "POST leaderboard": (account) => postLeaderboard(req, account),
      "POST unlink": (account) => unlink(req, account),
    };
    if (!routes[route]) return json({ error: "Not found." }, 404);
    const account = await authenticate(req);
    // Browsers attach the cookie to requests other sites trigger too, so only
    // this site's own pages may change anything with it.
    if (req.method === "POST" && account.viaCookie && req.headers.get("origin") !== SITE) {
      return json({ error: "Not allowed from here." }, 403);
    }
    return await routes[route](account);
  } catch (err) {
    if (err.status && err.status < 500) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config = { path: "/api/account/*" };
