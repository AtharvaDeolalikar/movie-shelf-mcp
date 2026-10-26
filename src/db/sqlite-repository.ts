import { normaliseTitle } from "../lib/text.js";
import type { Db } from "./sqlite.js";
import type {
  CatalogueRepository,
  ImportKind,
  ImportRun,
  ImportRunRepository,
  KeywordRepository,
  LanguageCoverage,
  LanguageRepository,
  LanguageRow,
  LanguageSource,
  MovieRepository,
  MovieRow,
  MovieSummary,
  RecommendQuery,
  TitleMatch,
  TitleSearchQuery,
  TitleType,
  TmdbLookupStatus,
  TypeFilter,
  WatchedEntry,
  WatchedInput,
  WatchedListQuery,
  WatchedRepository,
  WatchlistEntry,
  WatchlistInput,
  WatchlistQuery,
  WatchlistRepository,
} from "./repository.js";
import { MOVIES_INDEXES_DDL, moviesTableDdl } from "./schema.js";

const STAGING = "movies_staging";

const nowIso = () => new Date().toISOString();

export class SqliteCatalogueRepository implements CatalogueRepository {
  constructor(private readonly db: Db) {}

  async countMovies(): Promise<number> {
    return this.db.prepare("SELECT COUNT(*) FROM movies").pluck().get() as number;
  }

  async beginStaging(): Promise<void> {
    this.db.exec(`DROP TABLE IF EXISTS ${STAGING}; ${moviesTableDdl(STAGING)};`);
  }

  async insertStaging(rows: readonly MovieRow[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO ${STAGING}
         (imdb_id, title, original_title, year, runtime_min, genres, rating, votes, title_norm, original_norm,
          title_type, end_year)
       VALUES (@imdb_id, @title, @original_title, @year, @runtime_min, @genres, @rating, @votes,
               @title_norm, @original_norm, @title_type, @end_year)`,
    );
    this.db.transaction((batch: readonly MovieRow[]) => {
      for (const row of batch) {
        stmt.run({
          ...row,
          title_norm: normaliseTitle(row.title),
          original_norm: row.original_title === null ? null : normaliseTitle(row.original_title),
        });
      }
    })(rows);
  }

  async countStaging(): Promise<number> {
    return this.db.prepare(`SELECT COUNT(*) FROM ${STAGING}`).pluck().get() as number;
  }

  async swapStaging(): Promise<void> {
    // DDL is transactional in SQLite: readers see either the old or the new
    // catalogue, never an empty or partial one.
    this.db.transaction(() => {
      this.db.exec(`
        DROP TABLE movies;
        ALTER TABLE ${STAGING} RENAME TO movies;
        ${MOVIES_INDEXES_DDL}
      `);
    })();
    this.db.pragma("optimize");
  }

  async discardStaging(): Promise<void> {
    this.db.exec(`DROP TABLE IF EXISTS ${STAGING}`);
  }
}

export class SqliteImportRunRepository implements ImportRunRepository {
  constructor(private readonly db: Db) {}

  async startRun(kind: ImportKind): Promise<number> {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE import_runs
              SET status = 'interrupted', finished_at = ?,
                  error = COALESCE(error, 'process exited before the run finished')
            WHERE kind = ? AND status = 'running'`,
        )
        .run(nowIso(), kind);
      const info = this.db
        .prepare(`INSERT INTO import_runs (kind, started_at, status) VALUES (?, ?, 'running')`)
        .run(kind, nowIso());
      return Number(info.lastInsertRowid);
    })();
  }

  async finishRun(
    id: number,
    result: { status: "success" | "failed" | "interrupted"; rows?: number; error?: string },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE import_runs SET finished_at = ?, status = ?, rows = ?, error = ? WHERE id = ?`,
      )
      .run(nowIso(), result.status, result.rows ?? null, result.error ?? null, id);
  }

  async latestRuns(kind: ImportKind, limit: number): Promise<ImportRun[]> {
    return this.db
      .prepare(`SELECT * FROM import_runs WHERE kind = ? ORDER BY id DESC LIMIT ?`)
      .all(kind, limit) as ImportRun[];
  }
}

export class SqliteLanguageRepository implements LanguageRepository {
  constructor(private readonly db: Db) {}

  async countBySource(source: LanguageSource): Promise<number> {
    return this.db
      .prepare("SELECT COUNT(*) FROM movie_language WHERE source = ?")
      .pluck()
      .get(source) as number;
  }

  async replaceWikidata(
    rows: readonly LanguageRow[],
    fetchedAt: string,
  ): Promise<{ written: number; removed: number }> {
    const upsert = this.db.prepare(
      `INSERT INTO movie_language (imdb_id, lang, source, fetched_at)
       VALUES (?, ?, 'wikidata', ?)
       ON CONFLICT (imdb_id) DO UPDATE
         SET lang = excluded.lang, source = 'wikidata', fetched_at = excluded.fetched_at
         WHERE movie_language.source IN ('wikidata', 'tmdb')`,
    );
    return this.db.transaction(() => {
      // Sweep by set membership, not timestamps, so clock changes can't matter.
      this.db.exec(
        "DROP TABLE IF EXISTS temp.wikidata_ids; CREATE TEMP TABLE wikidata_ids (imdb_id TEXT PRIMARY KEY) WITHOUT ROWID",
      );
      const remember = this.db.prepare("INSERT OR IGNORE INTO temp.wikidata_ids VALUES (?)");
      let written = 0;
      for (const r of rows) {
        remember.run(r.imdb_id);
        written += upsert.run(r.imdb_id, r.lang, fetchedAt).changes;
      }
      const removed = this.db
        .prepare(
          `DELETE FROM movie_language
            WHERE source = 'wikidata' AND imdb_id NOT IN (SELECT imdb_id FROM temp.wikidata_ids)`,
        )
        .run().changes;
      this.db.exec("DROP TABLE temp.wikidata_ids");
      return { written, removed };
    })();
  }

  async tmdbCandidates(filter: {
    minRating: number;
    minVotes: number;
    retryBefore: string;
    limit: number;
  }): Promise<string[]> {
    return this.db
      .prepare(
        `SELECT m.imdb_id
           FROM movies m
           LEFT JOIN movie_language l ON l.imdb_id = m.imdb_id
           LEFT JOIN tmdb_lookups t ON t.imdb_id = m.imdb_id
          WHERE m.rating > ? AND m.votes >= ?
            AND l.imdb_id IS NULL
            AND (t.imdb_id IS NULL OR t.fetched_at < ?)
          ORDER BY m.votes DESC
          LIMIT ?`,
      )
      .pluck()
      .all(filter.minRating, filter.minVotes, filter.retryBefore, filter.limit) as string[];
  }

  async recordTmdbLookup(
    imdbId: string,
    status: TmdbLookupStatus,
    lang: string | null,
    fetchedAt: string,
  ): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tmdb_lookups (imdb_id, status, lang, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (imdb_id) DO UPDATE
             SET status = excluded.status, lang = excluded.lang, fetched_at = excluded.fetched_at`,
        )
        .run(imdbId, status, lang, fetchedAt);
      if (status === "found" && lang !== null) {
        this.db
          .prepare(
            `INSERT INTO movie_language (imdb_id, lang, source, fetched_at)
             VALUES (?, ?, 'tmdb', ?)
             ON CONFLICT (imdb_id) DO UPDATE
               SET lang = excluded.lang, fetched_at = excluded.fetched_at
               WHERE movie_language.source = 'tmdb'`,
          )
          .run(imdbId, lang, fetchedAt);
      }
    })();
  }

  async coverage(filter: { minRating: number; minVotes: number; top: number }): Promise<LanguageCoverage> {
    const scoped = `FROM movies m LEFT JOIN movie_language l ON l.imdb_id = m.imdb_id
                    WHERE m.rating > @minRating AND m.votes >= @minVotes`;
    const params = { minRating: filter.minRating, minVotes: filter.minVotes };
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS movies,
                COUNT(l.imdb_id) AS withLanguage,
                COALESCE(SUM(l.source = 'wikidata'), 0) AS wikidata,
                COALESCE(SUM(l.source = 'tmdb'), 0) AS tmdb,
                COALESCE(SUM(l.source = 'manual'), 0) AS manual
         ${scoped}`,
      )
      .get(params) as { movies: number; withLanguage: number; wikidata: number; tmdb: number; manual: number };
    const topLanguages = this.db
      .prepare(
        `SELECT l.lang, COUNT(*) AS movies ${scoped} AND l.lang IS NOT NULL
         GROUP BY l.lang ORDER BY movies DESC LIMIT @top`,
      )
      .all({ ...params, top: filter.top }) as { lang: string; movies: number }[];
    return {
      movies: totals.movies,
      withLanguage: totals.withLanguage,
      bySource: { wikidata: totals.wikidata, tmdb: totals.tmdb, manual: totals.manual },
      topLanguages,
    };
  }
}

export class SqliteKeywordRepository implements KeywordRepository {
  constructor(private readonly db: Db) {}

  async keywordCandidates(filter: {
    minRating: number;
    minVotes: number;
    retryBefore: string;
    limit: number;
  }): Promise<string[]> {
    return this.db
      .prepare(
        `SELECT m.imdb_id
           FROM movies m
           LEFT JOIN tmdb_keyword_lookups t ON t.imdb_id = m.imdb_id
          WHERE m.rating > ? AND m.votes >= ?
            AND (t.imdb_id IS NULL OR (t.status = 'not_found' AND t.fetched_at < ?))
          ORDER BY m.votes DESC
          LIMIT ?`,
      )
      .pluck()
      .all(filter.minRating, filter.minVotes, filter.retryBefore, filter.limit) as string[];
  }

  async recordKeywords(
    imdbId: string,
    status: "found" | "not_found",
    keywords: readonly string[],
    fetchedAt: string,
  ): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tmdb_keyword_lookups (imdb_id, status, fetched_at) VALUES (?, ?, ?)
           ON CONFLICT (imdb_id) DO UPDATE SET status = excluded.status, fetched_at = excluded.fetched_at`,
        )
        .run(imdbId, status, fetchedAt);
      if (status !== "found") return;
      this.db.prepare("DELETE FROM movie_keyword WHERE imdb_id = ?").run(imdbId);
      const insert = this.db.prepare("INSERT OR IGNORE INTO movie_keyword (imdb_id, keyword) VALUES (?, ?)");
      for (const keyword of keywords) insert.run(imdbId, keyword);
    })();
  }

  async keywordCoverage(filter: { minRating: number; minVotes: number; top: number }) {
    const params = { minRating: filter.minRating, minVotes: filter.minVotes, top: filter.top };
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS movies,
                COALESCE(SUM(EXISTS (SELECT 1 FROM movie_keyword k WHERE k.imdb_id = m.imdb_id)), 0) AS withKeywords
           FROM movies m WHERE m.rating > @minRating AND m.votes >= @minVotes`,
      )
      .get(params) as { movies: number; withKeywords: number };
    const topKeywords = this.db
      .prepare(
        `SELECT k.keyword, COUNT(*) AS movies
           FROM movie_keyword k JOIN movies m ON m.imdb_id = k.imdb_id
          WHERE m.rating > @minRating AND m.votes >= @minVotes
          GROUP BY k.keyword ORDER BY movies DESC, k.keyword LIMIT @top`,
      )
      .all(params) as { keyword: string; movies: number }[];
    return { ...totals, topKeywords };
  }
}

const MOVIE_COLUMNS = `m.imdb_id, m.title, m.original_title, m.year, m.title_type, m.end_year, m.runtime_min, m.genres,
  m.rating, m.votes, l.lang,
  EXISTS (SELECT 1 FROM watchlist wl WHERE wl.imdb_id = m.imdb_id) AS on_watchlist`;

type MovieRowWithFlag = Omit<MovieSummary, "on_watchlist"> & { on_watchlist: number };
const withWatchlistFlag = (r: MovieRowWithFlag): MovieSummary => ({ ...r, on_watchlist: r.on_watchlist === 1 });

/** Series filter: tvSeries and tvMiniSeries both count as "series". */
function typeCondition(type: TypeFilter | undefined, where: string[]): void {
  if (type === "movie") where.push("m.title_type = 'movie'");
  else if (type === "series") where.push("m.title_type IN ('tvSeries', 'tvMiniSeries')");
}

/** `,Crime,Drama,` LIKE `%,Drama,%`: whole-genre match ("Music" != "Musical"). */
const genreCondition = (column: string, param: string) => `(',' || ${column} || ',') LIKE ${param}`;
const genreLike = (genre: string) => `%,${genre},%`;

/** Adds a LIKE condition per wanted genre: a movie must have every one of them. */
function includeGenreConditions(genres: readonly string[] | undefined, params: Record<string, unknown>, where: string[]): void {
  genres?.forEach((genre, i) => {
    where.push(genreCondition("m.genres", `@genre${i}`));
    params[`genre${i}`] = genreLike(genre);
  });
}

/** Adds a NOT-LIKE condition per excluded genre; movies without genre data are kept. */
function excludeGenreConditions(genres: readonly string[] | undefined, params: Record<string, unknown>, where: string[]): void {
  genres?.forEach((genre, i) => {
    where.push(`NOT ${genreCondition("COALESCE(m.genres, '')", `@exGenre${i}`)}`);
    params[`exGenre${i}`] = genreLike(genre);
  });
}

/** Escapes LIKE wildcards so keyword text is matched literally (use with ESCAPE '\'). */
const keywordLike = (keyword: string) => `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;

const keywordExists = (condition: string) =>
  `EXISTS (SELECT 1 FROM movie_keyword k WHERE k.imdb_id = m.imdb_id AND ${condition})`;

/** A movie needs a keyword containing each of `all`, and one containing any of `any`. */
function keywordConditions(
  all: readonly string[] | undefined,
  any: readonly string[] | undefined,
  params: Record<string, unknown>,
  where: string[],
): void {
  all?.forEach((keyword, i) => {
    where.push(keywordExists(`k.keyword LIKE @kw${i} ESCAPE '\\'`));
    params[`kw${i}`] = keywordLike(keyword);
  });
  if (any?.length) {
    const ors = any.map((keyword, i) => {
      params[`kwAny${i}`] = keywordLike(keyword);
      return `k.keyword LIKE @kwAny${i} ESCAPE '\\'`;
    });
    where.push(keywordExists(`(${ors.join(" OR ")})`));
  }
}

/**
 * Every word of `norm` must appear in the title or original title.
 * Normalised text contains only letters, digits and spaces, so no LIKE
 * escaping is needed.
 */
function titleWordConditions(norm: string, params: Record<string, unknown>, prefix: string): string[] {
  return norm
    .split(" ")
    .filter(Boolean)
    .map((word, i) => {
      params[`${prefix}${i}`] = `%${word}%`;
      return `(m.title_norm LIKE @${prefix}${i} OR m.original_norm LIKE @${prefix}${i})`;
    });
}

export class SqliteMovieRepository implements MovieRepository {
  constructor(private readonly db: Db) {}

  async recommend(q: RecommendQuery): Promise<{ total: number; movies: MovieSummary[] }> {
    const params: Record<string, unknown> = { minRating: q.minRating, minVotes: q.minVotes, limit: q.limit };
    const where = [
      "m.rating > @minRating",
      "m.votes >= @minVotes",
      "NOT EXISTS (SELECT 1 FROM watched w WHERE w.imdb_id = m.imdb_id)",
    ];
    if (q.lang !== undefined) {
      where.push("l.lang = @lang");
      params.lang = q.lang;
    }
    typeCondition(q.type, where);
    includeGenreConditions(q.genres, params, where);
    excludeGenreConditions(q.excludeGenres, params, where);
    keywordConditions(q.keywords, q.keywordsAny, params, where);
    if (q.yearFrom !== undefined) {
      where.push("m.year >= @yearFrom");
      params.yearFrom = q.yearFrom;
    }
    if (q.yearTo !== undefined) {
      where.push("m.year <= @yearTo");
      params.yearTo = q.yearTo;
    }
    const from = `FROM movies m LEFT JOIN movie_language l ON l.imdb_id = m.imdb_id WHERE ${where.join(" AND ")}`;
    const order = q.sort === "shuffle" ? "random()" : "m.rating DESC, m.votes DESC, m.imdb_id";

    return this.db.transaction(() => {
      const total = this.db.prepare(`SELECT COUNT(*) ${from}`).pluck().get(params) as number;
      const movies = this.db
        .prepare(`SELECT ${MOVIE_COLUMNS} ${from} ORDER BY ${order} LIMIT @limit`)
        .all(params) as MovieRowWithFlag[];
      return { total, movies: movies.map(withWatchlistFlag) };
    })();
  }

  async searchTitles(q: TitleSearchQuery): Promise<(MovieSummary & { match: TitleMatch; watched: boolean })[]> {
    const params: Record<string, unknown> = { norm: q.norm, prefix: `${q.norm}%`, limit: q.limit };
    const where = titleWordConditions(q.norm, params, "w");
    if (where.length === 0) return [];
    if (q.yearFrom !== undefined) {
      where.push("m.year >= @yearFrom");
      params.yearFrom = q.yearFrom;
    }
    if (q.yearTo !== undefined) {
      where.push("m.year <= @yearTo");
      params.yearTo = q.yearTo;
    }
    const rows = this.db
      .prepare(
        `SELECT ${MOVIE_COLUMNS},
                CASE WHEN m.title_norm = @norm OR m.original_norm = @norm THEN 'exact'
                     WHEN m.title_norm LIKE @prefix OR m.original_norm LIKE @prefix THEN 'prefix'
                     ELSE 'contains' END AS match_kind,
                EXISTS (SELECT 1 FROM watched w WHERE w.imdb_id = m.imdb_id) AS watched
           FROM movies m LEFT JOIN movie_language l ON l.imdb_id = m.imdb_id
          WHERE ${where.join(" AND ")}
          ORDER BY CASE match_kind WHEN 'exact' THEN 0 WHEN 'prefix' THEN 1 ELSE 2 END, m.votes DESC
          LIMIT @limit`,
      )
      .all(params) as (MovieRowWithFlag & { match_kind: TitleMatch; watched: number })[];
    return rows.map(({ match_kind, watched, ...movie }) => ({
      ...withWatchlistFlag(movie),
      match: match_kind,
      watched: watched === 1,
    }));
  }

  async getMovie(imdbId: string): Promise<(MovieSummary & { watched: boolean }) | null> {
    const row = this.db
      .prepare(
        `SELECT ${MOVIE_COLUMNS}, EXISTS (SELECT 1 FROM watched w WHERE w.imdb_id = m.imdb_id) AS watched
           FROM movies m LEFT JOIN movie_language l ON l.imdb_id = m.imdb_id
          WHERE m.imdb_id = ?`,
      )
      .get(imdbId) as (MovieRowWithFlag & { watched: number }) | undefined;
    if (!row) return null;
    const { watched, ...movie } = row;
    return { ...withWatchlistFlag(movie), watched: watched === 1 };
  }
}

/* ---------- personal lists (watched, watchlist) ---------- */

/** Catalogue columns for a personal list joined to movies; all null when the title isn't in the catalogue. */
const LIST_MOVIE_COLUMNS = `m.title, m.original_title, m.year, m.title_type, m.end_year, m.runtime_min, m.genres, m.rating, m.votes, l.lang`;

interface ListMovieColumns {
  imdb_id: string;
  title: string | null;
  original_title: string | null;
  year: number | null;
  title_type: TitleType | null;
  end_year: number | null;
  runtime_min: number | null;
  genres: string | null;
  rating: number | null;
  votes: number | null;
  lang: string | null;
}

function listMovie(r: ListMovieColumns): MovieSummary | null {
  if (r.title === null) return null;
  return {
    imdb_id: r.imdb_id,
    title: r.title,
    original_title: r.original_title,
    year: r.year,
    title_type: r.title_type!,
    end_year: r.end_year,
    runtime_min: r.runtime_min,
    genres: r.genres,
    rating: r.rating!,
    votes: r.votes!,
    lang: r.lang,
  };
}

/** Language / genre / title-or-ID filters shared by both personal lists (`alias` is the list table). */
function listFilter(
  q: { lang?: string; type?: TypeFilter; genres?: string[]; excludeGenres?: string[]; norm?: string; imdbId?: string },
  params: Record<string, unknown>,
  alias: string,
): string {
  const where: string[] = [];
  if (q.lang !== undefined) {
    where.push("l.lang = @lang");
    params.lang = q.lang;
  }
  typeCondition(q.type, where);
  includeGenreConditions(q.genres, params, where);
  excludeGenreConditions(q.excludeGenres, params, where);
  if (q.imdbId !== undefined) {
    where.push(`${alias}.imdb_id = @imdbId`);
    params.imdbId = q.imdbId;
  } else if (q.norm) {
    const words = titleWordConditions(q.norm, params, "q");
    if (words.length) where.push(`(${words.join(" AND ")})`);
  }
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

const listJoins = (table: string, alias: string) => `
    FROM ${table} ${alias}
    LEFT JOIN movies m ON m.imdb_id = ${alias}.imdb_id
    LEFT JOIN movie_language l ON l.imdb_id = ${alias}.imdb_id`;

interface WatchedJoinRow extends ListMovieColumns {
  w_year: number | null;
  watched_on: string | null;
  my_rating: number | null;
  notes: string | null;
  added_via: string;
  added_at: string;
}

const WATCHED_SELECT = `
  SELECT w.imdb_id, w.year AS w_year, w.watched_on, w.my_rating, w.notes, w.added_via, w.added_at,
         ${LIST_MOVIE_COLUMNS}
  ${listJoins("watched", "w")}`;

function toWatchedEntry(r: WatchedJoinRow): WatchedEntry {
  return {
    imdb_id: r.imdb_id,
    watched_on: r.watched_on,
    my_rating: r.my_rating,
    notes: r.notes,
    added_via: r.added_via,
    added_at: r.added_at,
    year: r.year ?? r.w_year,
    movie: listMovie(r),
  };
}

export class SqliteWatchedRepository implements WatchedRepository {
  constructor(private readonly db: Db) {}

  async upsert(entry: WatchedInput): Promise<{ created: boolean; removedFromWatchlist: boolean }> {
    const r = await this.upsertMany([entry]);
    return { created: r.created === 1, removedFromWatchlist: r.removedFromWatchlist === 1 };
  }

  async upsertMany(
    entries: readonly WatchedInput[],
  ): Promise<{ created: number; updated: number; removedFromWatchlist: number }> {
    const exists = this.db.prepare("SELECT 1 FROM watched WHERE imdb_id = ?").pluck();
    const upsert = this.db.prepare(
      `INSERT INTO watched (imdb_id, year, watched_on, my_rating, notes, added_via)
       VALUES (@imdb_id, @year, @watched_on, @my_rating, @notes, @added_via)
       ON CONFLICT (imdb_id) DO UPDATE SET
         year       = COALESCE(excluded.year, watched.year),
         watched_on = COALESCE(excluded.watched_on, watched.watched_on),
         my_rating  = COALESCE(excluded.my_rating, watched.my_rating),
         notes      = COALESCE(excluded.notes, watched.notes)`,
    );
    // Watched movies leave the watchlist in the same transaction.
    const unlist = this.db.prepare("DELETE FROM watchlist WHERE imdb_id = ?");
    return this.db.transaction(() => {
      let created = 0;
      let removedFromWatchlist = 0;
      for (const e of entries) {
        if (!exists.get(e.imdb_id)) created++;
        upsert.run({
          imdb_id: e.imdb_id,
          year: e.year ?? null,
          watched_on: e.watched_on ?? null,
          my_rating: e.my_rating ?? null,
          notes: e.notes ?? null,
          added_via: e.added_via,
        });
        removedFromWatchlist += unlist.run(e.imdb_id).changes;
      }
      return { created, updated: entries.length - created, removedFromWatchlist };
    })();
  }

  async remove(imdbId: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM watched WHERE imdb_id = ?").run(imdbId).changes > 0;
  }

  async get(imdbId: string): Promise<WatchedEntry | null> {
    const row = this.db.prepare(`${WATCHED_SELECT} WHERE w.imdb_id = ?`).get(imdbId) as WatchedJoinRow | undefined;
    return row ? toWatchedEntry(row) : null;
  }

  async list(q: WatchedListQuery): Promise<{ total: number; entries: WatchedEntry[] }> {
    const params: Record<string, unknown> = { limit: q.limit, offset: q.offset };
    const filter = listFilter(q, params, "w");
    return this.db.transaction(() => {
      const total = this.db.prepare(`SELECT COUNT(*) ${listJoins("watched", "w")} ${filter}`).pluck().get(params) as number;
      const rows = this.db
        .prepare(
          `${WATCHED_SELECT} ${filter}
           ORDER BY COALESCE(w.watched_on, substr(w.added_at, 1, 10)) DESC, w.added_at DESC, w.imdb_id
           LIMIT @limit OFFSET @offset`,
        )
        .all(params) as WatchedJoinRow[];
      return { total, entries: rows.map(toWatchedEntry) };
    })();
  }
}

interface WatchlistJoinRow extends ListMovieColumns {
  wl_year: number | null;
  notes: string | null;
  added_via: string;
  added_at: string;
}

const WATCHLIST_SELECT = `
  SELECT wl.imdb_id, wl.year AS wl_year, wl.notes, wl.added_via, wl.added_at, ${LIST_MOVIE_COLUMNS}
  ${listJoins("watchlist", "wl")}`;

function toWatchlistEntry(r: WatchlistJoinRow): WatchlistEntry {
  return {
    imdb_id: r.imdb_id,
    notes: r.notes,
    added_via: r.added_via,
    added_at: r.added_at,
    year: r.year ?? r.wl_year,
    movie: listMovie(r),
  };
}

export class SqliteWatchlistRepository implements WatchlistRepository {
  constructor(private readonly db: Db) {}

  async add(entry: WatchlistInput): Promise<{ created: boolean }> {
    return { created: (await this.addMany([entry])).created === 1 };
  }

  async addMany(entries: readonly WatchlistInput[]): Promise<{ created: number; updated: number }> {
    const exists = this.db.prepare("SELECT 1 FROM watchlist WHERE imdb_id = ?").pluck();
    const upsert = this.db.prepare(
      `INSERT INTO watchlist (imdb_id, year, notes, added_via)
       VALUES (@imdb_id, @year, @notes, @added_via)
       ON CONFLICT (imdb_id) DO UPDATE SET
         year  = COALESCE(excluded.year, watchlist.year),
         notes = COALESCE(excluded.notes, watchlist.notes)`,
    );
    return this.db.transaction(() => {
      let created = 0;
      for (const e of entries) {
        if (!exists.get(e.imdb_id)) created++;
        upsert.run({ imdb_id: e.imdb_id, year: e.year ?? null, notes: e.notes ?? null, added_via: e.added_via });
      }
      return { created, updated: entries.length - created };
    })();
  }

  async remove(imdbId: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM watchlist WHERE imdb_id = ?").run(imdbId).changes > 0;
  }

  async get(imdbId: string): Promise<WatchlistEntry | null> {
    const row = this.db.prepare(`${WATCHLIST_SELECT} WHERE wl.imdb_id = ?`).get(imdbId) as WatchlistJoinRow | undefined;
    return row ? toWatchlistEntry(row) : null;
  }

  async list(q: WatchlistQuery): Promise<{ total: number; entries: WatchlistEntry[] }> {
    const params: Record<string, unknown> = { limit: q.limit, offset: q.offset };
    const filter = listFilter(q, params, "wl");
    // Titles outside the catalogue have no rating; they go last when sorting by rating.
    const order =
      q.sort === "rating"
        ? "m.rating IS NULL, m.rating DESC, m.votes DESC, wl.added_at DESC, wl.rowid DESC"
        : "wl.added_at DESC, wl.rowid DESC";
    return this.db.transaction(() => {
      const total = this.db.prepare(`SELECT COUNT(*) ${listJoins("watchlist", "wl")} ${filter}`).pluck().get(params) as number;
      const rows = this.db
        .prepare(`${WATCHLIST_SELECT} ${filter} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
        .all(params) as WatchlistJoinRow[];
      return { total, entries: rows.map(toWatchlistEntry) };
    })();
  }
}
