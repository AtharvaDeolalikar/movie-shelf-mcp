/**
 * Normalises a title for matching: lowercase, Latin diacritics removed,
 * apostrophes dropped ("Schindler's" -> "schindlers"), "&" -> "and", other
 * punctuation collapsed to single spaces, Roman numerals II-IX as digits
 * ("Part II" -> "part 2"), and a leading article removed ("The Godfather" ->
 * "godfather"). Non-Latin scripts are kept as-is.
 *
 * Changing this requires a migration that recomputes movies.title_norm.
 */
export function normaliseTitle(s: string): string {
  const t = titleWords(s);
  const stripped = t.replace(/^(the|a|an) /, "");
  return stripped || t;
}

/** normaliseTitle without dropping the leading article; used as a tie-breaker. */
export function titleWords(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ") // keep marks: Indic vowel signs
    .trim()
    .split(" ")
    .map((w) => ROMAN[w] ?? w)
    .join(" ");
}

// "v" and "x" are left alone: too often real letters ("Malcolm X").
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };

/** Extracts an IMDb title ID from "tt0111161" or an IMDb URL. */
export function parseImdbId(input: string): string | null {
  const m = /(?:^|\/)(tt\d{7,})(?:[/?#]|$)/.exec(input.trim());
  return m ? m[1]! : null;
}

export const imdbUrl = (imdbId: string) => `https://www.imdb.com/title/${imdbId}/`;
