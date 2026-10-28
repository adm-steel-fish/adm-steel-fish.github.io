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
//                         Supporters get more; see TIERS in netlify/lib/supporter.mjs.
//   MAIL_REGISTER_LIMIT   New players per IP address per UTC day (default 10).
//   MAIL_REPORT_LIMIT     Players who must report someone before that player's
//                         sending is switched off (default 3).
//
// Endpoints (all JSON; everything except register needs the X-Player-Id and
// X-Player-Secret headers):
//   POST /api/mail/register  { display_name? }      → { player_id, secret, friend_code, display_name }
//   POST /api/mail/send      { to, subject, body }  → { ok: true, sent_today, daily_limit }
//   (inbox letters also carry from_tier, the sender's supporter tier when sent: 0-4)
//   GET  /api/mail/inbox                            → { letters: [...] }  (oldest first)
//   POST /api/mail/ack       { ids: [...] }         → { deleted }
//   POST /api/mail/block     { code }               → { ok: true }
//   POST /api/mail/unblock   { code }               → { ok: true }
//   POST /api/mail/report    { letter, reason? }    → { ok: true }
// CORS is open to any origin, so web builds hosted elsewhere can call these.
//
// The game should save fetched letters locally *before* acking them. Acking
// deletes them from the server, so a tab closed in between just means the same
// letters come back on the next fetch; use each letter's id to skip duplicates.
//
// Moderation:
//   - Subjects, bodies and display names go through netlify/lib/mail-word-filter.mjs.
//   - Letters to a player who blocked the sender are dropped without telling
//     the sender, and still count toward the sender's daily limit.
//   - Since acked letters are deleted, a report carries the letter itself. Each
//     letter comes with a signature ("sig") made here, so a report can only
//     quote what was really sent. Reports land in the mail_reports collection
//     (read them in the Firebase console), and the reporter blocks the sender.
//     Once MAIL_REPORT_LIMIT different players report someone, that player can
//     no longer send; set their reportCount back to 0 in mail_players to undo.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  arrayRemove, arrayUnion, collection, doc, getDoc, getDocs, getFirestore,
  increment, query, runTransaction, serverTimestamp, where, writeBatch,
} from "firebase/firestore";
import { findBlockedWord } from "../lib/mail-word-filter.mjs";
import { tierForAccountId, tierInfo } from "../lib/supporter.mjs";

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
const REPORTS = "mail_reports";
const REGISTER_IPS = "mail_register_ips"; // keyed by a keyed hash of the IP, never the IP itself

const DAILY_LIMIT = Math.max(1, parseInt(process.env.MAIL_DAILY_LIMIT, 10) || 10);
const REGISTER_LIMIT = Math.max(1, parseInt(process.env.MAIL_REGISTER_LIMIT, 10) || 10);
const REPORT_LIMIT = Math.max(1, parseInt(process.env.MAIL_REPORT_LIMIT, 10) || 3);
const REPORTS_PER_DAY = 10; // per reporter, so one player can't flood the queue
const MAX_NAME = 24;
const MAX_SUBJECT = 80;
const MAX_BODY = 1000;
const MAX_REASON = 200;
const MAX_INBOX = 50; // matches Global.MAX_MAIL in the game
const MAX_ACK = 100;
const MAX_BLOCKED = 500;

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

// Server-only key for letter signatures and IP hashes. Derived from the mail
// server's password so there is no extra secret to set up; changing that
// password just means older letters can no longer be reported.
let serverKey = null;
function hmac(purpose, value) {
  serverKey ??= sha256("crispy-mail-key\n" + process.env.MAIL_SERVER_PASSWORD);
  return createHmac("sha256", serverKey).update(purpose + "\n" + value).digest("base64url");
}

function sameString(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Covers everything a report quotes, exactly as the inbox handed it out, and
// who it was handed to, so a letter passed around can't be reported by others.
function signLetter(letter, recipientId) {
  return hmac("letter", JSON.stringify([
    recipientId, letter.id, letter.from_code, letter.from_name, letter.subject, letter.body,
  ]));
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

// Friend code (already normalized) → player id, or null.
async function playerIdForCode(code) {
  const snap = await getDoc(doc(db, FRIEND_CODES, code));
  return snap.exists() ? snap.get("playerId") : null;
}

// ---- Handlers ----

// Caps new players per IP per day, so one person can't mint endless friend
// codes (e.g. to get around being blocked). Classrooms share an IP, hence the
// fairly generous default.
async function checkRegisterLimit(ip) {
  if (!ip) return;
  const ref = doc(db, REGISTER_IPS, hmac("ip", ip));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const today = utcDay();
    const count = snap.exists() && snap.get("day") === today ? snap.get("count") || 0 : 0;
    if (count >= REGISTER_LIMIT) {
      throw httpError("Too many new players from this network today. Try again tomorrow.", 429);
    }
    tx.set(ref, { day: today, count: count + 1 });
  });
}

async function register(req, context) {
  const body = await readBody(req);
  await checkRegisterLimit(context?.ip);
  // A rude name is dropped rather than refused; letters then show the friend code.
  let displayName = cleanName(body.display_name);
  if (findBlockedWord(displayName)) displayName = "";
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
        blocked: [],
        reportCount: 0,
        reportDay: "",
        reportsToday: 0,
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
  const badWord = findBlockedWord(subject) || findBlockedWord(text);
  if (badWord) {
    return json({ error: `Your letter has a word that isn't allowed ("${badWord}"). Please change it and try again.` }, 400);
  }

  const recipientId = await playerIdForCode(toCode);
  if (!recipientId) return json({ error: "No one has that friend code." }, 404);
  const recipientRef = doc(db, PLAYERS, recipientId);

  // Supporters (via the Discord account their mail is linked to) get a bigger
  // daily limit and a badge on their letters.
  const tier = await tierForAccountId(db, doc, player.data.accountId).catch(() => 0);
  const dailyLimit = DAILY_LIMIT + tierInfo(tier).extraLetters;

  // Counting and sending in one transaction, so parallel requests can't slip
  // past the daily limit.
  const sentToday = await runTransaction(db, async (tx) => {
    const me = await tx.get(player.ref);
    const recipient = await tx.get(recipientRef);
    if ((me.get("reportCount") || 0) >= REPORT_LIMIT) {
      throw httpError("Your mail has been switched off because other players reported your letters.", 403);
    }
    const today = utcDay();
    const count = me.get("sentDay") === today ? me.get("sentToday") || 0 : 0;
    if (count >= dailyLimit) {
      throw httpError(`You can only send ${dailyLimit} letters a day. Try again tomorrow.`, 429);
    }
    tx.update(player.ref, { sentDay: today, sentToday: count + 1 });
    // Blocked: looks sent to the sender, but is never delivered.
    if ((recipient.get("blocked") || []).includes(player.id)) return count + 1;
    tx.set(doc(collection(db, LETTERS)), {
      to: recipientId,
      from: player.id,
      fromName: me.get("displayName") || me.get("friendCode"),
      fromCode: me.get("friendCode"),
      fromTier: tier,
      subject,
      body: text,
      sentAt: serverTimestamp(),
    });
    return count + 1;
  });

  return json({ ok: true, sent_today: sentToday, daily_limit: dailyLimit });
}

async function inbox(player) {
  // A single equality filter, so no composite index is needed; sorted here.
  const snap = await getDocs(query(collection(db, LETTERS), where("to", "==", player.id)));
  const letters = snap.docs
    .map((d) => {
      const data = d.data();
      const letter = {
        id: d.id,
        from_name: data.fromName,
        from_code: data.fromCode,
        subject: data.subject,
        body: data.body,
        sent_unix: data.sentAt ? data.sentAt.toMillis() / 1000 : Date.now() / 1000,
      };
      letter.sig = signLetter(letter, player.id);
      letter.from_tier = data.fromTier || 0; // not signed: reports don't quote it
      return letter;
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

// Shared by block and report: stops letters from blockedId and removes any
// still waiting on the server.
async function blockPlayer(player, blockedId) {
  if ((player.data.blocked || []).length >= MAX_BLOCKED) {
    throw httpError(`You can block at most ${MAX_BLOCKED} players.`, 400);
  }
  const waiting = await getDocs(query(collection(db, LETTERS), where("to", "==", player.id)));
  const batch = writeBatch(db);
  batch.update(player.ref, { blocked: arrayUnion(blockedId) });
  for (const d of waiting.docs) if (d.get("from") === blockedId) batch.delete(d.ref);
  await batch.commit();
}

async function block(req, player) {
  const body = await readBody(req);
  const code = normalizeFriendCode(body.code);
  const blockedId = code && await playerIdForCode(code);
  if (!blockedId) return json({ error: "No one has that friend code." }, 404);
  if (blockedId === player.id) return json({ error: "You can't block yourself." }, 400);
  await blockPlayer(player, blockedId);
  return json({ ok: true });
}

async function unblock(req, player) {
  const body = await readBody(req);
  const code = normalizeFriendCode(body.code);
  const blockedId = code && await playerIdForCode(code);
  if (!blockedId) return json({ error: "No one has that friend code." }, 404);
  await writeBatch(db).update(player.ref, { blocked: arrayRemove(blockedId) }).commit();
  return json({ ok: true });
}

async function report(req, player) {
  const body = await readBody(req);
  const l = body.letter && typeof body.letter === "object" ? body.letter : {};
  const letter = {
    id: String(l.id ?? ""),
    from_code: String(l.from_code ?? ""),
    from_name: String(l.from_name ?? ""),
    subject: String(l.subject ?? ""),
    body: String(l.body ?? ""),
  };
  if (!/^[A-Za-z0-9]{1,64}$/.test(letter.id) || !sameString(l.sig, signLetter(letter, player.id))) {
    return json({ error: "That letter can't be reported." }, 400);
  }
  const code = normalizeFriendCode(letter.from_code);
  const senderId = code && await playerIdForCode(code);
  if (!senderId) return json({ error: "That letter can't be reported." }, 400);
  if (senderId === player.id) return json({ error: "You can't report yourself." }, 400);

  // One doc per reporter and sender, holding every letter that reporter
  // flagged, so each reporter adds at most one to the sender's reportCount.
  const reportRef = doc(db, REPORTS, `${player.id}_${senderId}`);
  const senderRef = doc(db, PLAYERS, senderId);
  const entry = {
    letterId: letter.id,
    fromName: letter.from_name,
    subject: letter.subject,
    body: letter.body,
    reason: cleanText(body.reason, MAX_REASON),
    reportedAt: new Date().toISOString(), // serverTimestamp() isn't allowed inside arrays
  };
  await runTransaction(db, async (tx) => {
    const me = await tx.get(player.ref);
    const existing = await tx.get(reportRef);
    const letters = existing.exists() ? existing.get("letters") || [] : [];
    if (letters.some((x) => x.letterId === letter.id)) return;
    const today = utcDay();
    const count = me.get("reportDay") === today ? me.get("reportsToday") || 0 : 0;
    if (count >= REPORTS_PER_DAY) {
      throw httpError("You've sent a lot of reports today. Try again tomorrow.", 429);
    }
    tx.update(player.ref, { reportDay: today, reportsToday: count + 1 });
    if (existing.exists()) {
      tx.update(reportRef, { letters: arrayUnion(entry), lastReportedAt: serverTimestamp() });
    } else {
      tx.set(reportRef, {
        reporterId: player.id,
        reporterCode: me.get("friendCode"),
        senderId,
        senderCode: code,
        letters: [entry],
        firstReportedAt: serverTimestamp(),
        lastReportedAt: serverTimestamp(),
      });
      tx.update(senderRef, { reportCount: increment(1) });
    }
  });

  await blockPlayer(player, senderId).catch(() => {}); // the report matters more
  return json({ ok: true });
}

export default async (req, context) => {
  // Browser preflight for the custom X-Player-* headers.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (!process.env.MAIL_SERVER_EMAIL || !process.env.MAIL_SERVER_PASSWORD) {
    return json({ error: "Mail isn't configured yet (missing MAIL_SERVER_EMAIL or MAIL_SERVER_PASSWORD)." }, 500);
  }

  const action = new URL(req.url).pathname.split("/").pop();
  try {
    await signIn();
    if (req.method === "POST" && action === "register") return await register(req, context);

    const routes = {
      "POST send": (player) => send(req, player),
      "GET inbox": (player) => inbox(player),
      "POST ack": (player) => ack(req, player),
      "POST block": (player) => block(req, player),
      "POST unblock": (player) => unblock(req, player),
      "POST report": (player) => report(req, player),
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
