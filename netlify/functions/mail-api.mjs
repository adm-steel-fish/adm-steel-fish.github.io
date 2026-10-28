// Backend for player-to-player mail in Crispy the Cat.
//
// Players have no accounts: the game registers once, gets a player id + secret
// to keep in its save file, and a friend code to hand out. Mail is addressed by
// friend code, so there is no way to look players up or message strangers.
//
// Mail lives in Firestore. This function signs in as a dedicated Firebase Auth
// user, and firestore.rules lets only that user touch the mail collections, so
// every limit below is enforced where players can't edit it. (A service
// account key isn't used because the organization policy blocks creating one.)
//
// Required environment variables (Netlify → Site configuration → Environment variables):
//   MAIL_SERVER_EMAIL     Email of the mail server's Firebase Auth user.
//   MAIL_SERVER_PASSWORD  Its password. Mark it as a secret.
// Optional:
//   MAIL_DAILY_LIMIT      Letters each player may send per UTC day (default 10).
//
// Endpoints (all JSON; everything except register needs the X-Player-Id and
// X-Player-Secret headers):
//   POST /api/mail/register  { display_name? }      → { player_id, secret, friend_code, display_name }
//   POST /api/mail/send      { to, subject, body }  → { ok: true, sent_today, daily_limit }
//   GET  /api/mail/inbox                            → { letters: [...] }  (oldest first)
//   POST /api/mail/ack       { ids: [...] }         → { deleted }
// CORS is open to any origin, so web builds hosted elsewhere can call these.
//
// The game should save fetched letters locally *before* acking them. Acking
// deletes them from the server, so a tab closed in between just means the same
// letters come back on the next fetch; use each letter's id to skip duplicates.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection, doc, getDoc, getDocs, getFirestore, query, runTransaction,
  serverTimestamp, where, writeBatch,
} from "firebase/firestore";

// Same public web config as news-article.js.
const firebaseConfig = {
  apiKey: "AIzaSyCM7alZkeWOEsNnp5fmza4t_dYdEz2H77M",
  authDomain: "steel-fish-studios.firebaseapp.com",
  projectId: "steel-fish-studios",
  storageBucket: "steel-fish-studios.firebasestorage.app",
  messagingSenderId: "655779279882",
  appId: "1:655779279882:web:587ad0f2ccb8c5ecefdbf3"
};

const PLAYERS = "mail_players";
const FRIEND_CODES = "mail_friend_codes"; // code → player id; doc ids make codes unique
const LETTERS = "mail_letters";

const DAILY_LIMIT = Math.max(1, parseInt(process.env.MAIL_DAILY_LIMIT, 10) || 10);
const MAX_NAME = 24;
const MAX_SUBJECT = 80;
const MAX_BODY = 1000;
const MAX_INBOX = 50; // matches Global.MAX_MAIL in the game
const MAX_ACK = 100;

// No 0/O, 1/I/L: friend codes get read aloud and typed in by hand.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

// ---- Firestore ----

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
let signingIn = null;

// Signs in once per warm function instance; the SDK refreshes the token after.
async function signIn() {
  if (auth.currentUser) return;
  signingIn ??= signInWithEmailAndPassword(
    auth, process.env.MAIL_SERVER_EMAIL, process.env.MAIL_SERVER_PASSWORD,
  ).finally(() => { signingIn = null; });
  await signingIn;
}

// ---- Helpers ----

// The game's web build may be served from another site (itch.io), so browsers
// need these to let it call us. "*" is safe: players authenticate with headers,
// not cookies. Cross-Origin-Resource-Policy covers pages that are
// cross-origin isolated, which Godot web builds usually are.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Player-Id, X-Player-Secret",
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

function sha256(s) {
  return createHash("sha256").update(s).digest();
}

async function readBody(req) {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    throw httpError("Invalid JSON.", 400);
  }
}

// Strips control characters (keeping newlines and tabs) and trims. Letters are
// shown in the game as escaped BBCode, so nothing else needs removing here.
function cleanText(value, max) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function cleanName(value) {
  return cleanText(value, MAX_NAME).replace(/\s+/g, " ");
}

function newFriendCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code.slice(0, 4) + "-" + code.slice(4);
}

// Accepts "abcd efgh", "ABCD-EFGH", etc. Returns null if it can't be a code.
function normalizeFriendCode(value) {
  const raw = String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!CODE_ALPHABET.includes(ch)) return null;
  return raw.slice(0, 4) + "-" + raw.slice(4);
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// ---- Auth ----

// Returns { id, ref, data } for the calling player, or throws 401.
async function authenticate(req) {
  const id = req.headers.get("x-player-id") || "";
  const secret = req.headers.get("x-player-secret") || "";
  // Firestore doc ids can't contain "/", and ours are always UUIDs.
  if (!/^[0-9a-f-]{36}$/.test(id) || !secret) throw httpError("Not signed in.", 401);

  const ref = doc(db, PLAYERS, id);
  const snap = await getDoc(ref);
  const stored = snap.exists() ? Buffer.from(snap.get("secretHash") || "", "hex") : null;
  const given = sha256(secret);
  if (!stored || stored.length !== given.length || !timingSafeEqual(stored, given)) {
    throw httpError("Not signed in.", 401);
  }
  return { id, ref, data: snap.data() };
}

// ---- Handlers ----

async function register(req) {
  const body = await readBody(req);
  const displayName = cleanName(body.display_name);
  const playerId = randomUUID();
  const secret = randomBytes(32).toString("base64url");

  // ~8.5e11 possible codes, so a collision is rare; we simply roll again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const friendCode = newFriendCode();
    const codeRef = doc(db, FRIEND_CODES, friendCode);
    const claimed = await runTransaction(db, async (tx) => {
      if ((await tx.get(codeRef)).exists()) return false;
      tx.set(codeRef, { playerId });
      tx.set(doc(db, PLAYERS, playerId), {
        secretHash: sha256(secret).toString("hex"),
        friendCode,
        displayName,
        createdAt: serverTimestamp(),
        sentDay: "",
        sentToday: 0,
      });
      return true;
    });
    if (claimed) {
      return json({ player_id: playerId, secret, friend_code: friendCode, display_name: displayName });
    }
  }
  throw new Error("Could not pick a friend code. Please try again.");
}

async function send(req, player) {
  const body = await readBody(req);
  const toCode = normalizeFriendCode(body.to);
  const subject = cleanText(body.subject, MAX_SUBJECT);
  const text = cleanText(body.body, MAX_BODY);
  if (!toCode) return json({ error: "That isn't a valid friend code." }, 400);
  if (!text) return json({ error: "The letter is empty." }, 400);
  if (toCode === player.data.friendCode) return json({ error: "You can't mail yourself." }, 400);

  const codeSnap = await getDoc(doc(db, FRIEND_CODES, toCode));
  if (!codeSnap.exists()) return json({ error: "No one has that friend code." }, 404);
  const recipientId = codeSnap.get("playerId");

  // Counting and sending in one transaction, so parallel requests can't slip
  // past the daily limit.
  const sentToday = await runTransaction(db, async (tx) => {
    const me = await tx.get(player.ref);
    const today = utcDay();
    const count = me.get("sentDay") === today ? me.get("sentToday") || 0 : 0;
    if (count >= DAILY_LIMIT) {
      throw httpError(`You can only send ${DAILY_LIMIT} letters a day. Try again tomorrow.`, 429);
    }
    tx.update(player.ref, { sentDay: today, sentToday: count + 1 });
    tx.set(doc(collection(db, LETTERS)), {
      to: recipientId,
      from: player.id,
      fromName: me.get("displayName") || me.get("friendCode"),
      fromCode: me.get("friendCode"),
      subject,
      body: text,
      sentAt: serverTimestamp(),
    });
    return count + 1;
  });

  return json({ ok: true, sent_today: sentToday, daily_limit: DAILY_LIMIT });
}

async function inbox(player) {
  // A single equality filter, so no composite index is needed; sorted here.
  const snap = await getDocs(query(collection(db, LETTERS), where("to", "==", player.id)));
  const letters = snap.docs
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        from_name: data.fromName,
        from_code: data.fromCode,
        subject: data.subject,
        body: data.body,
        sent_unix: data.sentAt ? data.sentAt.toMillis() / 1000 : Date.now() / 1000,
      };
    })
    .sort((a, b) => a.sent_unix - b.sent_unix)
    .slice(0, MAX_INBOX);
  return json({ letters });
}

async function ack(req, player) {
  const body = await readBody(req);
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id) => typeof id === "string" && /^[A-Za-z0-9]{1,64}$/.test(id)))]
    : [];
  if (!ids.length) return json({ deleted: 0 });
  if (ids.length > MAX_ACK) return json({ error: `At most ${MAX_ACK} ids at once.` }, 400);

  const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, LETTERS, id))));
  const batch = writeBatch(db);
  let deleted = 0;
  for (const snap of snaps) {
    // Ignore ids that are already gone or belong to someone else.
    if (snap.exists() && snap.get("to") === player.id) {
      batch.delete(snap.ref);
      deleted++;
    }
  }
  if (deleted) await batch.commit();
  return json({ deleted });
}

export default async (req) => {
  // Browser preflight for the custom X-Player-* headers.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (!process.env.MAIL_SERVER_EMAIL || !process.env.MAIL_SERVER_PASSWORD) {
    return json({ error: "Mail isn't configured yet (missing MAIL_SERVER_EMAIL or MAIL_SERVER_PASSWORD)." }, 500);
  }

  const action = new URL(req.url).pathname.split("/").pop();
  try {
    await signIn();
    if (req.method === "POST" && action === "register") return await register(req);

    const routes = {
      "POST send": (player) => send(req, player),
      "GET inbox": (player) => inbox(player),
      "POST ack": (player) => ack(req, player),
    };
    const route = routes[`${req.method} ${action}`];
    if (!route) return json({ error: "Not found." }, 404);
    return await route(await authenticate(req));
  } catch (err) {
    if (err.status && err.status < 500) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config = { path: "/api/mail/*" };
