// Supporter (backer) tiers, read from roles in the Steel Fish Studios Discord
// server. Ko-fi, Patreon and SubscribeStar each hand out the same four tier
// roles through their own Discord bots, so checking roles covers all three.
//
// Used by account-api.mjs (to tell the game) and mail-api.mjs (bigger daily
// letter limits, supporter badges). Results are cached on the account so
// Discord is asked at most once an hour per player.
//
// Needs DISCORD_BOT_TOKEN: the bot of the same Discord app as the login, added
// to the server with no permissions. It only reads one member at a time.

import { getDoc, updateDoc } from "firebase/firestore";

export const GUILD_ID = "1079569072418734150";

// Highest tier wins. 0 means not a supporter.
export const TIERS = [
  { tier: 1, name: "Bronze Guppy", roleId: "1095948511775830056", extraLetters: 0 },
  { tier: 2, name: "Silver Bass", roleId: "1095948584958042112", extraLetters: 5 },
  { tier: 3, name: "Golden Shark", roleId: "1095948606499999766", extraLetters: 15 },
  { tier: 4, name: "Platinum Ray", roleId: "1095948636875137075", extraLetters: 25 },
];

const CACHE_MS = 60 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000; // a forced re-check, e.g. right after backing

export function tierInfo(tier) {
  return TIERS.find((t) => t.tier === tier) || { tier: 0, name: "", extraLetters: 0 };
}

// Asks Discord for the member's roles. Returns { tier, inServer }, or null if
// Discord couldn't be asked (then the cached value stands).
async function fetchTier(discordId) {
  if (!process.env.DISCORD_BOT_TOKEN) return null;
  const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
  });
  if (res.status === 404) return { tier: 0, inServer: false };
  if (!res.ok) {
    console.error("Discord member lookup failed", res.status, await res.text().catch(() => ""));
    return null;
  }
  const member = await res.json();
  const roles = new Set(member.roles || []);
  const tier = Math.max(0, ...TIERS.filter((t) => roles.has(t.roleId)).map((t) => t.tier));
  return { tier, inServer: true };
}

// The account's supporter status, re-checked with Discord when the cached one
// is over an hour old (or a minute, with force). accountRef/accountData are
// the accounts/{id} document; returns { tier, name, in_server, checked_unix }.
export async function supporterStatus(accountRef, accountData, { force = false } = {}) {
  let cached = accountData?.supporter || null;
  const age = Date.now() - (cached?.checkedMs || 0);
  if (accountData?.discordId && (age > CACHE_MS || (force && age > MIN_REFRESH_MS))) {
    const fresh = await fetchTier(accountData.discordId).catch((err) => {
      console.error(err);
      return null;
    });
    if (fresh) {
      cached = { ...fresh, checkedMs: Date.now() };
      await updateDoc(accountRef, { supporter: cached });
    }
  }
  const tier = cached?.tier || 0;
  return {
    tier,
    name: tierInfo(tier).name,
    in_server: !!cached?.inServer,
    checked_unix: (cached?.checkedMs || 0) / 1000,
  };
}

// For mail-api: the supporter tier of a mail player, via its linked account.
export async function tierForAccountId(db, docFn, accountId) {
  if (!accountId) return 0;
  const ref = docFn(db, "accounts", accountId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return 0;
  return (await supporterStatus(ref, snap.data())).tier;
}
