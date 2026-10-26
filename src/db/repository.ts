/**
 * Storage interfaces. Import jobs and (later) MCP tools depend only on these,
 * so the SQLite implementation can be swapped for Postgres without touching
 * them. Methods are async for that reason even though better-sqlite3 is sync.
 */

/** IMDb `titleType` values kept in the catalogue. */
export type TitleType = "movie" | "tvSeries" | "tvMiniSeries";

/** Filter used by recommend and the personal lists: movies only, series (incl. miniseries) only, or both. */
export type TypeFilter = "movie" | "series" | "any";

export interface MovieRow {
  imdb_id: string;
  title: string;
  original_title: string | null;
  year: number | null;
  runtime_min: number | null;
  genres: string | null;
  rating: number;
  votes: number;
  title_type: TitleType;
  /** Series only; null while still running. */
  end_year: number | null;
}

export type ImportKind = "imdb" | "wikidata" | "tmdb" | "keywords";
export type ImportStatus = "running" | "success" | "failed" | "interrupted";

export interface ImportRun {
  id: number;
  kind: ImportKind;
  started_at: string;
  finished_at: string | null;
  rows: number | null;
  status: ImportStatus;
  error: string | null;
}

export interface CatalogueRepository {
  countMovies(): Promise<number>;

  /** Creates an empty staging table, discarding any leftover from a crashed run. */
  beginStaging(): Promise<void>;
  insertStaging(rows: readonly MovieRow[]): Promise<void>;
  countStaging(): Promise<number>;
  /** Atomically replaces the live catalogue with the staging table. */
  swapStaging(): Promise<void>;
  /** Drops the staging table; the live catalogue is untouched. */
  discardStaging(): Promise<void>;
}

export interface ImportRunRepository {
  /**
   * Records a new run. Any earlier run of the same kind still marked
   * `running` (i.e. the process died) is marked `interrupted` first.
   */
  startRun(kind: ImportKind): Promise<number>;
  finishRun(
    id: number,
    result: { status: Exclude<ImportStatus, "running">; rows?: number; error?: string },
  ): Promise<void>;
  latestRuns(kind: ImportKind, limit: number): Promise<ImportRun[]>;
}

export type LanguageSource = "wikidata" | "tmdb" | "manual";

export interface LanguageRow {
  imdb_id: string;
  /** ISO 639-1 code (TMDB's "cn" for Cantonese is the one exception). */
  lang: string;
}

export type TmdbLookupStatus = "found" | "not_found" | "no_language";

export interface LanguageCoverage {
  /** Movies passing the given rating/vote filter. */
  movies: number;
  withLanguage: number;
  bySource: Record<LanguageSource, number>;
  topLanguages: { lang: string; movies: number }[];
}

export interface LanguageRepository {
  countBySource(source: LanguageSource): Promise<number>;

  /**
   * Makes the Wikidata rows exactly `rows`, in one transaction: upserts them
   * (replacing earlier Wikidata/TMDB values, never manual ones) and deletes
   * Wikidata rows absent from `rows`.
   */
  replaceWikidata(rows: readonly LanguageRow[], fetchedAt: string): Promise<{ written: number; removed: number }>;

  /**
   * Movies passing the filter that have no language and no TMDB lookup newer
   * than `retryBefore`, most-voted first.
   */
  tmdbCandidates(filter: { minRating: number; minVotes: number; retryBefore: string; limit: number }): Promise<string[]>;

  /** Records a TMDB lookup; a found language is stored unless a manual/Wikidata one exists. */
  recordTmdbLookup(imdbId: string, status: TmdbLookupStatus, lang: string | null, fetchedAt: string): Promise<void>;

  coverage(filter: { minRating: number; minVotes: number; top: number }): Promise<LanguageCoverage>;
}

export interface KeywordRepository {
  /**
   * Movies passing the filter with no keyword lookup newer than `retryBefore`
   * (misses are retried, successes never), most-voted first.
   */
  keywordCandidates(filter: { minRating: number; minVotes: number; retryBefore: string; limit: number }): Promise<string[]>;
  /** Replaces the movie's keywords and logs the lookup. */
  recordKeywords(imdbId: string, status: "found" | "not_found", keywords: readonly string[], fetchedAt: string): Promise<void>;
  /** Movies passing the filter, how many have keywords, and the most common keywords. */
  keywordCoverage(filter: { minRating: number; minVotes: number; top: number }): Promise<{
    movies: number;
    withKeywords: number;
    topKeywords: { keyword: string; movies: number }[];
  }>;
}

/** A catalogue movie joined with its language. */
export interface MovieSummary {
  imdb_id: string;
  title: string;
  original_title: string | null;
  year: number | null;
  title_type: TitleType;
  end_year: number | null;
  /** Per-episode length for series. */
  runtime_min: number | null;
  genres: string | null;
  rating: number;
  votes: number;
  lang: string | null;
  /** Set by queries that check the watchlist (recommend, search, getMovie). */
  on_watchlist?: boolean;
}

export interface RecommendQuery {
  lang?: string;
  type?: TypeFilter;
  /** Canonical IMDb genres, e.g. ["Sci-Fi", "Horror"]; a movie must have ALL of them. */
  genres?: string[];
  /** Canonical IMDb genres; movies with any of them are left out. */
  excludeGenres?: string[];
  /** Substrings of TMDB keywords; a movie must have a keyword containing EACH of them. */
  keywords?: string[];
  /** Substrings of TMDB keywords; a movie must have a keyword containing AT LEAST ONE of them. */
  keywordsAny?: string[];
  /** Applied as rating > minRating. */
  minRating: number;
  minVotes: number;
  yearFrom?: number;
  yearTo?: number;
  limit: number;
  sort: "top" | "shuffle";
}

export type TitleMatch = "exact" | "prefix" | "contains";

export interface TitleSearchQuery {
  /** normaliseTitle(query) */
  norm: string;
  yearFrom?: number;
  yearTo?: number;
  limit: number;
}

export interface MovieRepository {
  /** Matching movies not in `watched`, plus the total match count. */
  recommend(q: RecommendQuery): Promise<{ total: number; movies: MovieSummary[] }>;
  /**
   * Movies whose normalised title or original title contains every word of
   * `norm`; exact matches first, then prefix, then by votes.
   */
  searchTitles(q: TitleSearchQuery): Promise<(MovieSummary & { match: TitleMatch; watched: boolean })[]>;
  getMovie(imdbId: string): Promise<(MovieSummary & { watched: boolean }) | null>;
}

export interface WatchedInput {
  imdb_id: string;
  year?: number | null;
  /** YYYY-MM-DD */
  watched_on?: string | null;
  my_rating?: number | null;
  notes?: string | null;
  added_via: "mcp" | "import" | "web";
}

export interface WatchedEntry {
  imdb_id: string;
  watched_on: string | null;
  my_rating: number | null;
  notes: string | null;
  added_via: string;
  added_at: string;
  /** Null when the title is not in the catalogue (e.g. under the vote floor). */
  movie: MovieSummary | null;
  /** Year from the watched row (used when the movie is not in the catalogue). */
  year: number | null;
}

export interface WatchedListQuery {
  lang?: string;
  type?: TypeFilter;
  genres?: string[];
  excludeGenres?: string[];
  /** normaliseTitle(query); also matched against imdb_id. */
  norm?: string;
  imdbId?: string;
  limit: number;
  offset: number;
}

export interface WatchedRepository {
  /**
   * Inserts or updates. On update, only provided (non-null) fields overwrite;
   * `added_via` keeps its original value. Also removes the movie from the
   * watchlist, in the same transaction.
   */
  upsert(entry: WatchedInput): Promise<{ created: boolean; removedFromWatchlist: boolean }>;
  /** Many upserts in one transaction (bulk import). */
  upsertMany(entries: readonly WatchedInput[]): Promise<{ created: number; updated: number; removedFromWatchlist: number }>;
  remove(imdbId: string): Promise<boolean>;
  get(imdbId: string): Promise<WatchedEntry | null>;
  /** Newest first: by watched_on, falling back to the date it was added. */
  list(q: WatchedListQuery): Promise<{ total: number; entries: WatchedEntry[] }>;
}

export interface WatchlistInput {
  imdb_id: string;
  year?: number | null;
  notes?: string | null;
  added_via: "mcp" | "import" | "web";
}

export interface WatchlistEntry {
  imdb_id: string;
  notes: string | null;
  added_via: string;
  added_at: string;
  /** Null when the title is not in the catalogue. */
  movie: MovieSummary | null;
  year: number | null;
}

export interface WatchlistQuery {
  lang?: string;
  type?: TypeFilter;
  genres?: string[];
  excludeGenres?: string[];
  norm?: string;
  imdbId?: string;
  /** "added": newest first; "rating": highest IMDb rating first. */
  sort: "added" | "rating";
  limit: number;
  offset: number;
}

export interface WatchlistRepository {
  /** Inserts, or on conflict updates notes (when given). */
  add(entry: WatchlistInput): Promise<{ created: boolean }>;
  addMany(entries: readonly WatchlistInput[]): Promise<{ created: number; updated: number }>;
  remove(imdbId: string): Promise<boolean>;
  get(imdbId: string): Promise<WatchlistEntry | null>;
  list(q: WatchlistQuery): Promise<{ total: number; entries: WatchlistEntry[] }>;
}
