// Word filter for player mail (netlify/functions/mail-api.mjs).
//
// Based on the list Pokémon Black/White use for nicknames and other player
// text (Bulbapedia, "List of censored words in Generation V"), adapted for
// letters, which are free text rather than a single name:
//   - Latin-script words must stand alone ("ass" is blocked, "class" is not).
//   - Japanese has no spaces, so its words match anywhere in the text, except
//     two-letter ones, which would hit too many innocent words.
//   - Korean puts spaces between words, so its words match at the start of a
//     word (catching attached particles like 을/를).
//   - Text is checked as written and again with simple look-alikes undone
//     ("$h1t" → "SHIT").
//
// Left out of the original list, because they are everyday words in English
// or another language a player might write in, or a topic a letter can
// reasonably mention: CON, CONO (Spanish "cone"; CONO with the tilde is kept),
// PINE, BITE, PEDE (Portuguese "asks"; PÉDÉ is kept), TARE (TARÉ is kept),
// POLVO, HOSTIA, OSTIA, CHICHI, SAU, TROIA, FICA, SA, SS, KZ, PD, ADHD,
// HOLOCAUST, DAMN, 9/11. Add or remove words in BLOCKED_WORDS below.

const BLOCKED_WORDS = [
  // German
  "ARSCH", "ARSCHLOCH", "BASTARD", "BITCH", "DRECKSACK", "DRECKSAU", "FICKEN",
  "FICKFRESSE", "FOTZE", "FUCK", "HACKFRESSE", "HITLER", "HOMO", "HURENSOHN",
  "JUDENSAU", "KACKE", "KANACKE", "MISSGEBURT", "NAZI", "NEGER", "NIGGER",
  "NUTTE", "PÄDOPHILER", "PADOPHILER", "PISSER", "SCHEIßE", "SCHLAMPE",
  "SCHWANZ", "SCHWUCHTEL", "SIEG HEIL", "SPASTI", "STRICHER", "VOLLIDIOT",
  "WICHSER",
  // Spanish
  "BOLLERA", "CABRÓN", "CABRON", "CABRONA", "CABRONAZO", "CAPULLA", "CAPULLO",
  "CHOCHO", "COJÓN", "COJON", "COJONES", "COMEPOLLAS", "COÑO", "CULO", "FOLLAR",
  "FOLLEN", "FURCIA", "GILIPOLLAS", "HIJAPUTA", "HIJO PUTA", "HIJOPUTA", "JODER",
  "JÓDETE", "JODETE", "JOPUTA", "MAMADA", "MAMÓN", "MAMON", "MAMONA", "MARICA",
  "MARICÓN", "MARICON", "MARICONA", "MARICONAZO", "OJETE", "PAJILLERO",
  "PENDÓN", "PENDON", "PICHA", "POLLA", "POLLÓN", "POLLON", "POTORRO", "PUTA",
  "PUTO", "PUTÓN", "PUTON", "TORTILLERA", "ZORRÓN", "ZORRON",
  // French
  "ABRUTI", "ABRUTIE", "BAISÉ", "BAISE", "BAISER", "BATARD", "BOUGNOUL",
  "BRANLEUR", "BURNE", "CHIER", "COCU", "CONNARD", "CONNASSE", "CONNE",
  "COUILLE", "COUILLON", "COUILLONNE", "CREVARD", "CUL", "ENCULÉ", "ENCULE",
  "ENCULÉE", "ENCULEE", "ENCULER", "ENFOIRÉ", "ENFOIRE", "FION", "FOUTRE",
  "MERDE", "NÈGRE", "NEGRE", "NÉGRESSE", "NEGRESSE", "NIQUE", "NIQUER",
  "PARTOUZE", "PÉDÉ", "PÉTASSE", "PETASSE", "POUFFE", "POUFFIASSE", "PUTAIN",
  "PUTE", "SALAUD", "SALOP", "SALOPARD", "SALOPE", "SODOMIE", "SUCER",
  "TAPETTE", "TARÉ", "VAGIN", "ZOB",
  // Italian
  "AFFANCULO", "BAGASCIA", "BALDRACCA", "BATTONA", "BOCCHINARA", "BOCCHINARO",
  "CAZZI", "CAZZO", "CHIAVARE", "COGLIONE", "CULATTONE", "DIO BESTIA",
  "DIO CANE", "DIO PORCO", "FANCULO", "FIGA", "FOTTERE", "FROCIO", "INCULARE",
  "MIGNOTTA", "MINCHIA", "POMPINARA", "POMPINO", "PORCO DIO", "PUTTANA",
  "RICCHIONE", "ROTTINCULO", "SBORRA", "SEGAIOLO", "TROIETTA", "TROIONA",
  "TROIONE", "VAFFANCULO", "ZOCCOLA",
  // Japanese (written in hiragana; katakana is converted before checking)
  "しね", "あいえき", "せいえき", "ふぁっく", "いぬごろし", "いんぱい", "いんもう",
  "うんこ", "うんち", "おめこ", "かたわ", "きちがい", "くろんぼ", "けとう", "ころす",
  "ごうかん", "さんごくじん", "しなじん", "せっくす", "ちゃんころ", "ちんこ", "ちんちん",
  "ちんぽ", "ちんば", "つんぼ", "どかた", "とさつ", "どもり", "にぐろ", "にんぴにん",
  "びっこ", "ひにん", "ふぇら", "ぶらく", "ぺにす", "まんこ", "おまんこ", "めくら",
  "やらせろ", "やりまん", "りょうじょく", "れいぷ", "ろりこん",
  // Korean
  "강간", "개새끼", "개지랄", "걸레같은년", "걸레년", "귀두", "내꺼빨아", "내꺼핥아",
  "니미랄", "딸딸이", "미친년", "미친놈", "병신", "보지", "부랄", "불알", "빠구리",
  "빠굴이", "사까시", "성감대", "성관계", "성폭행", "성행위", "섹스", "시팔년", "시팔놈",
  "쌍넘", "쌍년", "쌍놈", "쌍뇬", "씨발", "씨발넘", "씨발년", "씨발놈", "씨발뇬",
  "씹새끼", "엄창", "염병", "오르가즘", "왕자지", "유두", "자지", "잠지", "정액", "좆까",
  "창녀", "콘돔", "클리토리스", "페니스", "후장",
  // English
  "ANAL", "ANALPLUG", "ANALSEX", "ASS", "BLOWJOB", "BULLSHIT", "CHINK", "CLIT",
  "COCK", "COCKSUCKER", "COON", "CUM", "CUMSHOT", "CUNT", "DICK", "DICKHEAD",
  "DILDO", "DYKE", "F.U.C.K", "FAG", "FAGGOT", "FAGS", "FCUK", "FUCKER", "FUCT",
  "FUK", "GOBSHITE", "GODDAMN", "GYPO", "HANDJOB", "HORE", "JESUSSUCKS", "JIZZ",
  "JIZZUM", "KAFFIR", "KIKE", "KUNT", "LESBO", "MASTURBATE", "MOLEST", "NEGRO",
  "PAEDO", "PAEDOPHILE", "PAKI", "PECKER", "PEDO", "PEDOFILE", "PEDOPHILE",
  "PENIS", "PHUK", "POOF", "PUSSY", "QUEER", "RAPE", "RAPED", "RAPES", "RAPIST",
  "SCROTUM", "SEX", "SHIT", "SHIZ", "SLAG", "SLUT", "SPASTIC", "SPAZ", "SPERM",
  "SPUNK", "TITS", "TWAT", "VAGINA", "VULVA", "WANK", "WANKER", "WETBACK", "WHOR",
  "WHORE", "WOG",
];

// Look-alikes undone on the second pass.
const LOOKALIKES = { "0": "O", "1": "I", "3": "E", "4": "A", "5": "S", "7": "T", "@": "A", "$": "S", "!": "I" };

// Fullwidth → halfwidth (NFKC), upper case, katakana → hiragana.
function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function undoLookalikes(text) {
  return text.replace(/[013457@$!]/g, (ch) => LOOKALIKES[ch]);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOT_WORD = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

// One regex per word, built once per function instance.
const PATTERNS = BLOCKED_WORDS.map((word) => {
  const w = normalize(word);
  const body = escapeRegExp(w).replace(/ /g, "\\s+");
  let source;
  if (/\p{Script=Hiragana}/u.test(w)) {
    source = [...w].length <= 2 ? NOT_WORD + body + NOT_WORD_AFTER : body;
  } else if (/\p{Script=Hangul}/u.test(w)) {
    source = NOT_WORD + body;
  } else {
    source = NOT_WORD + body + NOT_WORD_AFTER;
  }
  return { word, regex: new RegExp(source, "u") };
});

// Returns the first blocked word found in the text (as it appears in the list,
// lower case), or null if the text is fine.
export function findBlockedWord(text) {
  const plain = normalize(text);
  const unleeted = undoLookalikes(plain);
  for (const { word, regex } of PATTERNS) {
    if (regex.test(plain) || regex.test(unleeted)) return word.toLowerCase();
  }
  return null;
}
