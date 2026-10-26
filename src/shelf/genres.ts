/** Genres that appear on IMDb movies (title.basics `genres`). */
export const IMDB_GENRES = [
  "Action",
  "Adventure",
  "Animation",
  "Biography",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "Film-Noir",
  "Game-Show",
  "History",
  "Horror",
  "Music",
  "Musical",
  "Mystery",
  "News",
  "Reality-TV",
  "Romance",
  "Sci-Fi",
  "Sport",
  "Talk-Show",
  "Thriller",
  "War",
  "Western",
] as const;

const ALIASES: Record<string, string> = {
  scifi: "Sci-Fi",
  sciencefiction: "Sci-Fi",
  sf: "Sci-Fi",
  noir: "Film-Noir",
  filmnoir: "Film-Noir",
  romantic: "Romance",
  romcom: "Romance",
  animated: "Animation",
  anime: "Animation",
  cartoon: "Animation",
  biopic: "Biography",
  biographical: "Biography",
  historical: "History",
  doc: "Documentary",
  docs: "Documentary",
  sports: "Sport",
  suspense: "Thriller",
  scary: "Horror",
  funny: "Comedy",
  kids: "Family",
  musicals: "Musical",
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const BY_KEY = new Map<string, string>(IMDB_GENRES.map((g) => [key(g), g]));

/** "thriller", "Thrillers", "sci fi", "Science Fiction" -> canonical IMDb genre, or null. */
export function normaliseGenre(input: string): string | null {
  const k = key(input);
  if (!k) return null;
  return BY_KEY.get(k) ?? ALIASES[k] ?? (k.endsWith("s") ? (BY_KEY.get(k.slice(0, -1)) ?? null) : null);
}
