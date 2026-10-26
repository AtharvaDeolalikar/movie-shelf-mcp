import { CATALOGUE_MIN_VOTES, DEFAULT_MIN_RATING, DEFAULT_MIN_VOTES } from "../config.js";
import type {
  MovieRepository,
  TitleType,
  TypeFilter,
  MovieSummary,
  TitleMatch,
  WatchedEntry,
  WatchedInput,
  WatchedRepository,
  WatchlistEntry,
  WatchlistInput,
  WatchlistRepository,
} from "../db/repository.js";
import { languageName, normaliseLanguage } from "../languages/normalise.js";
import { imdbUrl, normaliseTitle, parseImdbId, titleWords } from "../lib/text.js";
import { IMDB_GENRES, normaliseGenre } from "./genres.js";
import { MOODS, MOOD_NAMES, normaliseMood, type MoodName } from "./moods.js";

/** A validation problem the caller (user or model) can fix. */
export class ShelfError extends Error {}

const TYPE_FILTERS: readonly string[] = ["movie", "series", "any"] satisfies TypeFilter[];

export const RECOMMEND_MAX_LIMIT = 25;
export const SEARCH_MAX_LIMIT = 25;
export const LIST_MAX_LIMIT = 200;

export interface MovieOut {
  imdb_id: string;
  title: string;
  original_title?: string;
  /** "series" covers tvSeries; "miniseries" covers tvMiniSeries. */
  type: MediaType;
  year: number | null;
  /** Series only: last year it aired, null while it is still running. */
  end_year?: number | null;
  language: string | null;
  language_code: string | null;
  genres: string[];
  rating: number;
  votes: number;
  /** Per-episode length for series. */
  runtime_min: number | null;
  imdb_url: string;
  on_watchlist?: boolean;
}

export type MediaType = "movie" | "series" | "miniseries";
const MEDIA_TYPE: Record<TitleType, MediaType> = { movie: "movie", tvSeries: "series", tvMiniSeries: "miniseries" };
const mediaType = (t: TitleType | null | undefined): MediaType => MEDIA_TYPE[t ?? "movie"];

export interface SearchHit extends MovieOut {
  watched: boolean;
  match: TitleMatch;
}

export function toMovieOut(m: MovieSummary): MovieOut {
  return {
    imdb_id: m.imdb_id,
    title: m.title,
    ...(m.original_title ? { original_title: m.original_title } : {}),
    type: mediaType(m.title_type),
    year: m.year,
    ...(m.title_type !== "movie" ? { end_year: m.end_year } : {}),
    language: m.lang ? languageName(m.lang) : null,
    language_code: m.lang,
    genres: m.genres ? m.genres.split(",") : [],
    rating: m.rating,
    votes: m.votes,
    runtime_min: m.runtime_min,
    imdb_url: imdbUrl(m.imdb_id),
    ...(m.on_watchlist !== undefined ? { on_watchlist: m.on_watchlist } : {}),
  };
}

export interface RecommendInput {
  language?: string;
  type?: TypeFilter;
  genre?: string | string[];
  exclude_genres?: string[];
  keyword?: string | string[];
  mood?: string;
  min_rating?: number;
  min_votes?: number;
  year_from?: number;
  year_to?: number;
  limit?: number;
  sort?: "top" | "shuffle";
}

export interface MarkWatchedInput {
  imdb_id?: string;
  title?: string;
  year?: number;
  watched_on?: string;
  my_rating?: number;
  notes?: string;
}

export interface ListWatchedInput {
  language?: string;
  type?: TypeFilter;
  genre?: string | string[];
  exclude_genres?: string[];
  query?: string;
  limit?: number;
  offset?: number;
}

export interface AddToWatchlistInput {
  imdb_id?: string;
  title?: string;
  year?: number;
  notes?: string;
}

export interface ListWatchlistInput extends ListWatchedInput {
  sort?: "added" | "rating";
}

/** Outcome of turning {imdb_id | title + year} into one movie. */
type Target =
  | { resolved: true; imdbId: string; movie: MovieOut | null; year: number | null }
  | { resolved: false; reply: UnresolvedReply };

interface UnresolvedReply {
  status: "ambiguous" | "needs_confirmation" | "not_found";
  written: false;
  message: string;
  candidates: SearchHit[];
}

export type TitleResolution =
  | { status: "match"; movie: SearchHit }
  /** Several movies have exactly this title. */
  | { status: "ambiguous"; candidates: SearchHit[] }
  /** No exact title match, only partial ones. */
  | { status: "needs_confirmation"; candidates: SearchHit[] }
  | { status: "not_found"; candidates: [] };

export class ShelfService {
  constructor(
    private readonly movies: MovieRepository,
    private readonly watched: WatchedRepository,
    private readonly watchlist: WatchlistRepository,
  ) {}

  async recommend(input: RecommendInput) {
    const lang = input.language === undefined ? undefined : requireLanguage(input.language);
    const genres = requireGenres(input.genre);
    const mood = input.mood === undefined ? undefined : requireMood(input.mood);
    const keywords = requireKeywords(input.keyword);
    // A mood's contradicting genres are dropped quietly when the user asked for that genre.
    const excludeGenres = [
      ...new Set([
        ...requireExcludedGenres(input.exclude_genres, genres),
        ...(mood === undefined ? [] : (MOODS[mood].excludeGenres ?? []).filter((g) => !genres.includes(g))),
      ]),
    ];
    const minRating = input.min_rating ?? DEFAULT_MIN_RATING;
    const minVotes = input.min_votes ?? DEFAULT_MIN_VOTES;
    const limit = input.limit ?? 10;
    const sort = input.sort ?? "top";
    const type = input.type ?? "movie";
    if (!TYPE_FILTERS.includes(type)) throw new ShelfError(`type must be one of: ${TYPE_FILTERS.join(", ")}.`);

    if (!(minRating >= DEFAULT_MIN_RATING && minRating < 10)) {
      throw new ShelfError(`min_rating must be between ${DEFAULT_MIN_RATING.toFixed(1)} and 9.9 (results are always rated above ${DEFAULT_MIN_RATING.toFixed(1)}).`);
    }
    if (!(Number.isInteger(minVotes) && minVotes >= CATALOGUE_MIN_VOTES)) {
      throw new ShelfError(`min_votes must be an integer >= ${CATALOGUE_MIN_VOTES}.`);
    }
    requireLimit(limit, RECOMMEND_MAX_LIMIT);
    if (input.year_from !== undefined) requireYear(input.year_from, "year_from");
    if (input.year_to !== undefined) requireYear(input.year_to, "year_to");
    if (input.year_from !== undefined && input.year_to !== undefined && input.year_from > input.year_to) {
      throw new ShelfError("year_from must be <= year_to.");
    }

    const { total, movies } = await this.movies.recommend({
      minRating,
      minVotes,
      limit,
      sort,
      type,
      ...(lang !== undefined ? { lang } : {}),
      ...(genres.length ? { genres } : {}),
      ...(excludeGenres.length ? { excludeGenres } : {}),
      ...(keywords.length ? { keywords } : {}),
      ...(mood !== undefined ? { keywordsAny: [...MOODS[mood].keywords] } : {}),
      ...(input.year_from !== undefined ? { yearFrom: input.year_from } : {}),
      ...(input.year_to !== undefined ? { yearTo: input.year_to } : {}),
    });

    return {
      total_matches: total,
      showing: movies.length,
      filters: {
        language: lang === undefined ? null : { code: lang, name: languageName(lang) },
        type,
        genre: genres,
        exclude_genres: excludeGenres,
        keyword: keywords,
        mood: mood ?? null,
        min_rating: minRating,
        min_votes: minVotes,
        year_from: input.year_from ?? null,
        year_to: input.year_to ?? null,
        sort,
        excludes_watched: true,
      },
      movies: movies.map(toMovieOut),
    };
  }

  async searchTitle(input: { query: string; year?: number; limit?: number }) {
    const limit = input.limit ?? 5;
    requireLimit(limit, SEARCH_MAX_LIMIT);
    if (input.year !== undefined) requireYear(input.year, "year");

    const id = parseImdbId(input.query);
    if (id) {
      const movie = await this.movies.getMovie(id);
      return {
        query: input.query,
        results: movie ? [{ ...toMovieOut(movie), watched: movie.watched, match: "exact" as const }] : [],
      };
    }
    return { query: input.query, results: await this.search(input.query, input.year, limit) };
  }

  /**
   * Shared by mark_watched and the text-list import. A title is a strong
   * match only if exactly one catalogue movie has that exact (normalised)
   * title or original title, within the given year if one was given.
   */
  async resolveTitle(title: string, year?: number): Promise<TitleResolution> {
    const hits = await this.search(title, year, 10);
    const exact = hits.filter((h) => h.match === "exact");
    if (exact.length === 1) return { status: "match", movie: exact[0]! };
    if (exact.length > 1) {
      // "The Godfather" also equals "Godfather" once articles are dropped. If
      // the query has an article and exactly one candidate matches it with
      // the article kept, that's the one. (A bare "Godfather" stays ambiguous.)
      const words = titleWords(title);
      if (words !== normaliseTitle(title)) {
        const literal = exact.filter(
          (h) => titleWords(h.title) === words || (h.original_title !== undefined && titleWords(h.original_title) === words),
        );
        if (literal.length === 1) return { status: "match", movie: literal[0]! };
      }
      return { status: "ambiguous", candidates: exact };
    }
    if (hits.length > 0) return { status: "needs_confirmation", candidates: hits.slice(0, 5) };
    return { status: "not_found", candidates: [] };
  }

  /**
   * Resolves {imdb_id} or {title, year} to one movie, applying the strong-match
   * rule for titles. `tool` names the tool to call again in the reply.
   */
  private async resolveTarget(input: { imdb_id?: string; title?: string; year?: number }, tool: string): Promise<Target> {
    if (input.imdb_id !== undefined) {
      const id = parseImdbId(input.imdb_id);
      if (!id) throw new ShelfError(`"${input.imdb_id}" is not an IMDb title ID (expected e.g. "tt0111161").`);
      const movie = await this.movies.getMovie(id);
      return { resolved: true, imdbId: id, movie: movie ? toMovieOut(movie) : null, year: movie?.year ?? input.year ?? null };
    }
    if (input.title === undefined || !input.title.trim()) {
      throw new ShelfError("Provide either imdb_id or title.");
    }
    const r = await this.resolveTitle(input.title, input.year);
    if (r.status === "match") {
      const { watched: _w, match: _m, ...movie } = r.movie;
      return { resolved: true, imdbId: movie.imdb_id, movie, year: movie.year };
    }
    return {
      resolved: false,
      reply: {
        status: r.status,
        written: false,
        message:
          r.status === "not_found"
            ? `No movie titled "${input.title}" in the catalogue. Nothing was written. Try search_title with a different spelling, or pass an imdb_id.`
            : `Nothing was written: "${input.title}" ${r.status === "ambiguous" ? "matches several movies" : "has no exact match"}. ` +
              `Ask the user which one they mean, then call ${tool} again with that movie's imdb_id.`,
        candidates: r.candidates,
      },
    };
  }

  async markWatched(input: MarkWatchedInput) {
    const details = validateWatchedDetails(input);
    const target = await this.resolveTarget(input, "mark_watched");
    if (!target.resolved) return target.reply;

    const { created, removedFromWatchlist } = await this.watched.upsert({
      imdb_id: target.imdbId,
      year: target.year,
      ...details,
      added_via: "mcp",
    });
    return {
      status: "marked" as const,
      written: true,
      created,
      removed_from_watchlist: removedFromWatchlist,
      imdb_id: target.imdbId,
      imdb_url: imdbUrl(target.imdbId),
      movie: target.movie ? { ...target.movie, on_watchlist: false } : null,
      ...(target.movie ? {} : { note: NOT_IN_CATALOGUE }),
    };
  }

  async addToWatchlist(input: AddToWatchlistInput) {
    const notes = input.notes?.trim() || null;
    const target = await this.resolveTarget(input, "add_to_watchlist");
    if (!target.resolved) return target.reply;

    const seen = await this.watched.get(target.imdbId);
    if (seen) {
      return {
        status: "already_watched" as const,
        written: false,
        message:
          `Not added: the user already watched this${seen.watched_on ? ` (on ${seen.watched_on})` : ""}. ` +
          "If they want to rewatch it, call unmark_watched first.",
        imdb_id: target.imdbId,
        movie: target.movie,
      };
    }
    const { created } = await this.watchlist.add({ imdb_id: target.imdbId, year: target.year, notes, added_via: "mcp" });
    return {
      status: "added" as const,
      written: true,
      created,
      imdb_id: target.imdbId,
      imdb_url: imdbUrl(target.imdbId),
      movie: target.movie ? { ...target.movie, on_watchlist: true } : null,
      ...(target.movie ? {} : { note: NOT_IN_CATALOGUE }),
    };
  }

  async removeFromWatchlist(input: { imdb_id: string }) {
    const id = parseImdbId(input.imdb_id);
    if (!id) throw new ShelfError(`"${input.imdb_id}" is not an IMDb title ID (expected e.g. "tt0111161").`);
    const entry = await this.watchlist.get(id);
    const removed = await this.watchlist.remove(id);
    return {
      imdb_id: id,
      removed,
      title: entry?.movie?.title ?? null,
      ...(removed ? {} : { message: "That movie was not on the watchlist." }),
    };
  }

  async listWatchlist(input: ListWatchlistInput) {
    const { limit, offset, filters } = this.listParams(input);
    const { total, entries } = await this.watchlist.list({ limit, offset, sort: input.sort ?? "added", ...filters });
    return { total, offset, showing: entries.length, sort: input.sort ?? "added", entries: entries.map(toWatchlistOut) };
  }

  /** Bulk add for the import CLI; titles already watched are skipped. */
  async importWatchlist(entries: readonly WatchlistInput[]) {
    const fresh: WatchlistInput[] = [];
    const alreadyWatched: string[] = [];
    for (const e of entries) {
      if (await this.watched.get(e.imdb_id)) alreadyWatched.push(e.imdb_id);
      else fresh.push(e);
    }
    return { ...(await this.watchlist.addMany(fresh)), alreadyWatched };
  }

  async unmarkWatched(input: { imdb_id: string }) {
    const id = parseImdbId(input.imdb_id);
    if (!id) throw new ShelfError(`"${input.imdb_id}" is not an IMDb title ID (expected e.g. "tt0111161").`);
    const entry = await this.watched.get(id);
    const removed = await this.watched.remove(id);
    return {
      imdb_id: id,
      removed,
      title: entry?.movie?.title ?? null,
      ...(removed ? {} : { message: "That movie was not in the watched list." }),
    };
  }

  async listWatched(input: ListWatchedInput) {
    const { limit, offset, filters } = this.listParams(input);
    const { total, entries } = await this.watched.list({ limit, offset, ...filters });
    return { total, offset, showing: entries.length, entries: entries.map(toWatchedOut) };
  }

  /** Validates the paging and filter params shared by list_watched and list_watchlist. */
  private listParams(input: ListWatchedInput) {
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    requireLimit(limit, LIST_MAX_LIMIT);
    if (!(Number.isInteger(offset) && offset >= 0)) throw new ShelfError("offset must be an integer >= 0.");
    const lang = input.language === undefined ? undefined : requireLanguage(input.language);
    if (input.type !== undefined && !TYPE_FILTERS.includes(input.type)) {
      throw new ShelfError(`type must be one of: ${TYPE_FILTERS.join(", ")}.`);
    }
    const genres = requireGenres(input.genre);
    const excludeGenres = requireExcludedGenres(input.exclude_genres, genres);
    const query = input.query?.trim() || undefined;
    const imdbId = query ? parseImdbId(query) : null;
    return {
      limit,
      offset,
      filters: {
        ...(lang !== undefined ? { lang } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(genres.length ? { genres } : {}),
        ...(excludeGenres.length ? { excludeGenres } : {}),
        ...(imdbId ? { imdbId } : query ? { norm: normaliseTitle(query) } : {}),
      },
    };
  }

  /** Bulk upsert for the watched-list import CLI. */
  async importWatched(entries: readonly WatchedInput[]) {
    return this.watched.upsertMany(entries);
  }

  private async search(query: string, year: number | undefined, limit: number): Promise<SearchHit[]> {
    const norm = normaliseTitle(query);
    if (!norm) throw new ShelfError("The title query is empty.");
    const run = async (yearFrom?: number, yearTo?: number) =>
      (
        await this.movies.searchTitles({
          norm,
          limit,
          ...(yearFrom !== undefined ? { yearFrom } : {}),
          ...(yearTo !== undefined ? { yearTo } : {}),
        })
      ).map(({ match, watched, ...m }) => ({ ...toMovieOut(m), watched, match }));

    if (year === undefined) return run();
    const hits = await run(year, year);
    // Release years are often remembered off by one.
    return hits.length > 0 ? hits : run(year - 1, year + 1);
  }
}

const NOT_IN_CATALOGUE =
  "Not in the local catalogue (fewer than 100 IMDb votes, not yet rated, or not a movie or TV series); saved by ID.";

function toWatchlistOut(e: WatchlistEntry) {
  const m = e.movie;
  return {
    imdb_id: e.imdb_id,
    title: m?.title ?? null,
    type: m ? mediaType(m.title_type) : null,
    year: e.year,
    in_catalogue: m !== null,
    language: m?.lang ? languageName(m.lang) : null,
    language_code: m?.lang ?? null,
    genres: m?.genres ? m.genres.split(",") : [],
    imdb_rating: m?.rating ?? null,
    votes: m?.votes ?? null,
    runtime_min: m?.runtime_min ?? null,
    notes: e.notes,
    added_at: e.added_at,
    imdb_url: imdbUrl(e.imdb_id),
  };
}

function toWatchedOut(e: WatchedEntry) {
  const m = e.movie;
  return {
    imdb_id: e.imdb_id,
    title: m?.title ?? null,
    type: m ? mediaType(m.title_type) : null,
    year: e.year,
    in_catalogue: m !== null,
    language: m?.lang ? languageName(m.lang) : null,
    language_code: m?.lang ?? null,
    genres: m?.genres ? m.genres.split(",") : [],
    imdb_rating: m?.rating ?? null,
    watched_on: e.watched_on,
    my_rating: e.my_rating,
    notes: e.notes,
    imdb_url: imdbUrl(e.imdb_id),
  };
}

function requireLanguage(input: string): string {
  const code = normaliseLanguage(input);
  if (!code) {
    throw new ShelfError(
      `Unknown language "${input}". Use an ISO 639-1 code (e.g. "ml", "ko") or an English name (e.g. "Malayalam", "Korean").`,
    );
  }
  return code;
}

/** `genre` accepts one genre or a list; a movie must have all of them. */
function requireGenres(input: string | readonly string[] | undefined): string[] {
  if (input === undefined) return [];
  return [...new Set((typeof input === "string" ? [input] : input).map(requireGenre))];
}

function requireExcludedGenres(input: readonly string[] | undefined, include: readonly string[]): string[] {
  const genres = [...new Set((input ?? []).map(requireGenre))];
  const clash = genres.find((g) => include.includes(g));
  if (clash !== undefined) throw new ShelfError(`genre and exclude_genres both contain "${clash}".`);
  return genres;
}

function requireMood(input: string): MoodName {
  const mood = normaliseMood(input);
  if (!mood) throw new ShelfError(`Unknown mood "${input}". Valid moods: ${MOOD_NAMES.join(", ")}.`);
  return mood;
}

function requireKeywords(input: string | readonly string[] | undefined): string[] {
  if (input === undefined) return [];
  const keywords = (typeof input === "string" ? [input] : input).map((k) => k.trim().toLowerCase());
  if (keywords.some((k) => k === "")) throw new ShelfError("keyword must not be empty.");
  return [...new Set(keywords)];
}

function requireGenre(input: string): string {
  const genre = normaliseGenre(input);
  if (!genre) throw new ShelfError(`Unknown genre "${input}". Valid genres: ${IMDB_GENRES.join(", ")}.`);
  return genre;
}

function requireLimit(limit: number, max: number): void {
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= max)) {
    throw new ShelfError(`limit must be an integer from 1 to ${max}.`);
  }
}

function requireYear(year: number, name: string): void {
  if (!(Number.isInteger(year) && year >= 1870 && year <= 2100)) {
    throw new ShelfError(`${name} must be a four-digit year.`);
  }
}

/** Validates the optional watched fields shared by mark_watched and imports. */
export function validateWatchedDetails(input: { watched_on?: string; my_rating?: number; notes?: string }) {
  if (input.watched_on !== undefined && !isIsoDate(input.watched_on)) {
    throw new ShelfError(`watched_on must be a date in YYYY-MM-DD format, got "${input.watched_on}".`);
  }
  if (input.my_rating !== undefined && !(input.my_rating >= 1 && input.my_rating <= 10)) {
    throw new ShelfError("my_rating must be between 1 and 10.");
  }
  const notes = input.notes?.trim();
  return {
    watched_on: input.watched_on ?? null,
    my_rating: input.my_rating ?? null,
    notes: notes ? notes : null,
  };
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
