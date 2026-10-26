/**
 * Language normalisation: accepts an ISO 639-1 code ("ml"), an ISO 639-2/3
 * code ("mal") or an English name ("Malayalam", "Bengali") and returns the
 * ISO 639-1 code used in `movie_language.lang`.
 */

// prettier-ignore
const ISO_639_1 = (
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy " +
  "da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu " +
  "hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb " +
  "lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om " +
  "or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw " +
  "ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu"
).split(" ");

/**
 * TMDB reports Cantonese as "cn" (Cantonese has no ISO 639-1 code). We keep
 * it as-is so TMDB-sourced Cantonese films stay filterable.
 */
const EXTRA_CODES: Record<string, string> = { cn: "Cantonese" };

/** Names people commonly use that differ from the CLDR English name. */
const ALIASES: Record<string, string> = {
  bengali: "bn",
  bangla: "bn",
  oriya: "or",
  odia: "or",
  farsi: "fa",
  persian: "fa",
  mandarin: "zh",
  "mandarin chinese": "zh",
  chinese: "zh",
  cantonese: "cn",
  tagalog: "tl",
  filipino: "tl",
  castilian: "es",
  flemish: "nl",
  "brazilian portuguese": "pt",
  burmese: "my",
  myanmar: "my",
  "kirghiz": "ky",
  "panjabi": "pa",
  "sinhalese": "si",
  "moldavian": "ro",
  "moldovan": "ro",
  "hebrew": "he",
  "iw": "he", // legacy ISO code for Hebrew
  "in": "id", // legacy ISO code for Indonesian
  "ji": "yi", // legacy ISO code for Yiddish
  "norwegian": "no",
};

const displayNames = new Intl.DisplayNames(["en"], { type: "language" });

const CODES = new Set([...ISO_639_1, ...Object.keys(EXTRA_CODES)]);
const NAME_TO_CODE = new Map<string, string>();
for (const code of ISO_639_1) {
  const name = displayNames.of(code);
  if (!name || name === code) continue;
  const key = nameKey(name);
  NAME_TO_CODE.set(key, code);
  // "Norwegian Bokmål" -> also "norwegian bokmal"; "Myanmar (Burmese)" -> "myanmar"
  const base = key.replace(/\s*\(.*\)\s*/g, "").trim();
  if (base && !NAME_TO_CODE.has(base)) NAME_TO_CODE.set(base, code);
}
for (const [alias, code] of Object.entries(ALIASES)) NAME_TO_CODE.set(nameKey(alias), code);

function nameKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z() ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns the language code for a code or name, or null if unrecognised. */
export function normaliseLanguage(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (CODES.has(raw)) return raw;

  const byName = NAME_TO_CODE.get(nameKey(raw));
  if (byName) return byName;

  // ISO 639-2/3 three-letter codes ("mal", "kor"); ICU canonicalises them.
  if (/^[a-z]{3}$/.test(raw)) {
    try {
      const [canonical] = Intl.getCanonicalLocales(raw);
      if (canonical && CODES.has(canonical)) return canonical;
    } catch {
      // not a valid language subtag
    }
  }
  return null;
}

/** Validates a code coming from a data source (Wikidata/TMDB). */
export function isKnownLanguageCode(code: string): boolean {
  return CODES.has(code);
}

/** English display name for a stored code, e.g. "ml" -> "Malayalam". */
export function languageName(code: string): string {
  if (EXTRA_CODES[code]) return EXTRA_CODES[code];
  if (code === "bn") return "Bengali"; // CLDR says "Bangla"; Bengali is more familiar
  const name = displayNames.of(code);
  return name && name !== code ? name : code;
}
