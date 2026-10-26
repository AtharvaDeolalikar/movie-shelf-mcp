/**
 * Schema definitions. The `movies` DDL is a function of the table name because
 * the IMDb import builds `movies_staging` with the identical shape and then
 * renames it over `movies`. It must always equal the shape the migrations
 * below produce.
 */

export function moviesTableDdl(table: string): string {
  return `
    CREATE TABLE ${table} (
      imdb_id        TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      original_title TEXT,
      year           INTEGER,
      runtime_min    INTEGER,
      genres         TEXT,
      rating         REAL NOT NULL,
      votes          INTEGER NOT NULL,
      title_norm     TEXT NOT NULL DEFAULT '',  -- normaliseTitle(title)
      original_norm  TEXT,                      -- normaliseTitle(original_title)
      title_type     TEXT NOT NULL DEFAULT 'movie',  -- IMDb titleType: movie | tvSeries | tvMiniSeries
      end_year       INTEGER                    -- series only; NULL while running
    ) WITHOUT ROWID`;
}

/** Indexes on `movies`; recreated after every staging swap. */
export const MOVIES_INDEXES_DDL = `
  CREATE INDEX IF NOT EXISTS idx_movies_rating_votes ON movies (rating DESC, votes DESC);
  CREATE INDEX IF NOT EXISTS idx_movies_year ON movies (year);
  CREATE INDEX IF NOT EXISTS idx_movies_title ON movies (title COLLATE NOCASE);
`;

/**
 * Ordered migrations, tracked via `PRAGMA user_version`. Append only; never
 * edit a migration that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE movies (
    imdb_id        TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    original_title TEXT,
    year           INTEGER,
    runtime_min    INTEGER,
    genres         TEXT,
    rating         REAL NOT NULL,
    votes          INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX idx_movies_rating_votes ON movies (rating DESC, votes DESC);
  CREATE INDEX idx_movies_year ON movies (year);
  CREATE INDEX idx_movies_title ON movies (title COLLATE NOCASE);

  -- Survives catalogue swaps: lives in its own table, no FK to movies.
  CREATE TABLE movie_language (
    imdb_id    TEXT PRIMARY KEY,
    lang       TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('wikidata', 'tmdb', 'manual')),
    fetched_at TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX idx_movie_language_lang ON movie_language (lang, imdb_id);

  -- No FK to movies: a watched title may be missing from the catalogue
  -- (e.g. under the vote floor) and must survive catalogue swaps.
  CREATE TABLE watched (
    imdb_id    TEXT PRIMARY KEY,
    year       INTEGER,
    watched_on TEXT,
    my_rating  REAL CHECK (my_rating IS NULL OR (my_rating >= 1 AND my_rating <= 10)),
    notes      TEXT,
    added_via  TEXT NOT NULL CHECK (added_via IN ('mcp', 'import', 'web')),
    added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) WITHOUT ROWID;
  CREATE INDEX idx_watched_order ON watched (watched_on DESC, added_at DESC);

  CREATE TABLE import_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    rows        INTEGER,
    status      TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'interrupted')),
    error       TEXT
  );
  CREATE INDEX idx_import_runs_kind ON import_runs (kind, started_at DESC);
  `,

  // 2: TMDB lookup log, so misses are not re-queried on every run
  `
  CREATE TABLE tmdb_lookups (
    imdb_id    TEXT PRIMARY KEY,
    status     TEXT NOT NULL CHECK (status IN ('found', 'not_found', 'no_language')),
    lang       TEXT,
    fetched_at TEXT NOT NULL
  ) WITHOUT ROWID;
  `,

  // 3: normalised titles for search_title / mark_watched matching.
  // norm_title() is registered by openDatabase().
  `
  ALTER TABLE movies ADD COLUMN title_norm TEXT NOT NULL DEFAULT '';
  ALTER TABLE movies ADD COLUMN original_norm TEXT;
  UPDATE movies SET title_norm = norm_title(title), original_norm = norm_title(original_title);
  `,

  // 4: normaliseTitle() now maps Roman numerals; recompute stored keys
  `
  UPDATE movies SET title_norm = norm_title(title), original_norm = norm_title(original_title);
  `,

  // 5: watchlist ("want to watch"). Like `watched`, no FK to movies so it
  // survives catalogue swaps and can hold titles outside the catalogue.
  // A rowid table on purpose: rowid breaks added_at ties (bulk imports land
  // in the same millisecond) so "newest first" follows insertion order.
  `
  CREATE TABLE watchlist (
    imdb_id   TEXT PRIMARY KEY,
    year      INTEGER,
    notes     TEXT,
    added_via TEXT NOT NULL CHECK (added_via IN ('mcp', 'import', 'web')),
    added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_watchlist_added ON watchlist (added_at DESC);
  `,

  // 6: TMDB keywords (lowercased) for the keyword / mood filters. Like
  // movie_language, no FK to movies so they survive catalogue swaps.
  // tmdb_keyword_lookups records misses so they are not re-queried every run;
  // a movie TMDB knows but has no keywords for is 'found' with no rows.
  `
  CREATE TABLE movie_keyword (
    imdb_id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    PRIMARY KEY (imdb_id, keyword)
  ) WITHOUT ROWID;
  CREATE INDEX idx_movie_keyword_keyword ON movie_keyword (keyword, imdb_id);

  CREATE TABLE tmdb_keyword_lookups (
    imdb_id    TEXT PRIMARY KEY,
    status     TEXT NOT NULL CHECK (status IN ('found', 'not_found')),
    fetched_at TEXT NOT NULL
  ) WITHOUT ROWID;
  `,

  // 7: series support. Existing rows are movies; the next IMDb import adds
  // tvSeries / tvMiniSeries rows. Column order must match moviesTableDdl().
  `
  ALTER TABLE movies ADD COLUMN title_type TEXT NOT NULL DEFAULT 'movie';
  ALTER TABLE movies ADD COLUMN end_year INTEGER;
  `,
];
