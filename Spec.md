# Movie Shelf — MCP server for "what should I watch?"

## Goal

A personal movie-recommendation backend that any LLM client can use through MCP
(Claude, ChatGPT developer-mode connectors, Gemini CLI, Cursor, etc.).

When I ask for a movie, optionally with a genre and/or language, the answer must:
- include only movies rated **above 7.0 on IMDb** (strictly greater than 7.0),
- **never** include a movie I've already watched,
- come from real data, not the model's memory.

**Core principle:** the server does all filtering, rating checks and watched-list
exclusion in the database. The LLM only turns my request into tool parameters and
presents the results. This keeps results identical across models and stops any
model from inventing ratings.

Personal, non-commercial use only (IMDb dataset licence requires this).

## Stack

- Node.js + TypeScript (strict mode)
- Official MCP TypeScript SDK (`@modelcontextprotocol/sdk`)
- Transports: **stdio** for local testing, **Streamable HTTP** (`/mcp`) for remote use
- Auth on HTTP: bearer token from an env var (single user); OAuth not needed yet
- Database: **SQLite** (`better-sqlite3`) behind a small repository layer, so it
  can be swapped for Postgres (Neon/Supabase) later without touching tool code
- No ORM required; plain SQL with typed helpers is fine

## Data sources

### 1. IMDb non-commercial datasets (daily)
Download from `https://datasets.imdbws.com/`. Use only:
- `title.basics.tsv.gz` — tconst, titleType, primaryTitle, originalTitle, isAdult,
  startYear, endYear, runtimeMinutes, genres (comma-separated, max 3)
- `title.ratings.tsv.gz` — tconst, averageRating, numVotes

Do **not** download or store `title.akas`, `title.principals`, `title.crew`, `name.basics`.

Import rules:
- Stream-decompress and parse line by line. Never write the raw ~1 GB file to disk or DB.
- `\N` means null.
- Keep rows where `titleType = 'movie'`, `isAdult = 0`, has a rating, and `numVotes >= 100`.
  (Store at a low vote floor so the recommend threshold can change without re-importing.)
- Load into a staging table, then swap it in atomically (rename / transaction),
  so a failed import never leaves a half-empty catalogue.
- Record each run in `import_runs` (start, end, rows kept, status, error).
- Expected size after filtering: tens of MB at most.

### 2. Original language (not available reliably in IMDb files)
IMDb files have no usable original-language field, and title-script heuristics fail
for Indian films (e.g. Malayalam "Drishyam" vs its Hindi remake share a Latin-script
title). Indian languages are the most important filter, so this must be solid.

Strategy, stored in its own table so it survives daily catalogue swaps:
1. **Wikidata (primary, bulk):** one SPARQL query against
   `https://query.wikidata.org/sparql` for films with an IMDb ID (P345) and an
   original language (P364); take the language's ISO 639-1 code (P218).
   Run it once for the backfill, then periodically (e.g. weekly).
2. **TMDB (fallback, per title):** for IMDb IDs that pass the default recommend
   filter but have no language after Wikidata, call
   `GET https://api.themoviedb.org/3/find/{imdb_id}?external_source=imdb_id`
   and read `movie_results[0].original_language`. Free API key from env var.
   Respect rate limits; only query IDs not already resolved.
3. Movies with no resolved language are still recommendable when no language
   filter is given, and excluded when one is.

Store language as an ISO 639-1 code (`hi`, `ml`, `ta`, `te`, `kn`, `mr`, `bn`,
`ko`, `ja`, `en`, `es`, `fr`, …). Tools must accept either the code or the English
name ("Malayalam") and normalise it.

### 3. Later (phase 4, optional)
From TMDB: poster, short overview, and streaming availability for region `IN`
(watch providers endpoint). Cache with a fetched_at timestamp.

## Schema (starting point)

```sql
movies (
  imdb_id TEXT PRIMARY KEY,        -- tt1234567
  title TEXT NOT NULL,
  original_title TEXT,
  year INTEGER,
  runtime_min INTEGER,
  genres TEXT,                     -- comma-separated as in IMDb; or a join table
  rating REAL NOT NULL,
  votes INTEGER NOT NULL
)

movie_language (
  imdb_id TEXT PRIMARY KEY,
  lang TEXT NOT NULL,              -- ISO 639-1
  source TEXT NOT NULL,            -- 'wikidata' | 'tmdb' | 'manual'
  fetched_at TEXT NOT NULL
)

watched (
  imdb_id TEXT PRIMARY KEY,        -- title/year come from `movies` via join
  year INTEGER,
  watched_on TEXT,                 -- date, optional
  my_rating REAL,                  -- optional, 1-10
  notes TEXT,
  added_via TEXT NOT NULL          -- 'mcp' | 'import' | 'web'
)

import_runs (id, kind, started_at, finished_at, rows, status, error)
```

Add indexes for the recommend query (rating, votes, year; language join).

## MCP tools

Tool descriptions must be clear enough that any model picks the right tool and
passes correct parameters without extra prompting.

### `recommend`
Params (all optional):
- `language` — code or name
- `genre` — one IMDb genre (Action, Comedy, Crime, Drama, Thriller, Romance, Sci-Fi, …); case-insensitive
- `min_rating` — default 7.0, applied as `rating > min_rating`
- `min_votes` — default 1000
- `year_from`, `year_to`
- `limit` — default 10, max 25
- `sort` — `top` (default: rating desc, then votes desc) or `shuffle` (random sample
  from the matching set, for variety when I ask again)

Always excludes everything in `watched`. Returns per movie: imdb_id, title, year,
language, genres, rating, votes, runtime, and `https://www.imdb.com/title/{imdb_id}/`.
Also return the total match count so the model can say "showing 10 of 143".

### `search_title`
Params: `query` (required), `year` (optional), `limit` (default 5).
Returns matching movies with imdb_id, year, language, rating, votes and whether
each is already watched. Used to disambiguate titles.

### `mark_watched`
Params: `imdb_id` **or** `title` (+ optional `year`), plus optional `watched_on`,
`my_rating`, `notes`.
- With `imdb_id`: write directly.
- With `title`: if exactly one strong match, write it; if ambiguous, **write nothing**
  and return the candidates so the model can ask me which one.
- Idempotent: marking an already-watched movie updates it, never duplicates.

### `unmark_watched`
Params: `imdb_id`. Removes it from `watched`.

### `list_watched`
Params: optional `language`, `genre`, `query`, `limit` (default 50), `offset`.
Newest first. Title and other details come from a LEFT JOIN on `movies`; a watched
entry that isn't in the catalogue (e.g. under the vote floor) is still listed, with
its imdb_id and IMDb link in place of a title.

## Watched-list import

A CLI script to bulk-import my history:
- **IMDb "Your Ratings" export CSV**: use the `Const` column as imdb_id; also read
  `Your Rating`, `Date Rated` and `Year`. Import only rows where `Title Type` is a movie.
- **Plain text list** (one title per line, optional year): resolve each via the same
  logic as `search_title`; write confident matches, and print a report of
  ambiguous / unmatched lines for me to fix by hand.

Note: a small claude.ai page ("Watched Shelf") currently holds a few **sample**
entries only. Do not import them.

## Phases

1. **Catalogue pipeline** — project setup, schema, IMDb download + streaming import
   with staging swap, `import_runs` logging. CLI command: `npm run import:imdb`.
2. **Language enrichment** — Wikidata bulk job + TMDB fallback, language name/code
   normalisation. CLI: `npm run import:languages`.
3. **MCP server (stdio)** — all five tools, watched-list import script, tests.
   Verify locally with MCP Inspector and Claude Desktop/Claude Code.
4. **Remote** — Streamable HTTP transport with bearer auth, Dockerfile, daily
   scheduled import (cron in the container or the host's scheduler), deploy.
   Then add it as a custom connector in claude.ai and ChatGPT.
5. **Extras** (optional) — TMDB posters/overview, streaming availability in India,
   a minimal phone-friendly web page to mark movies watched without an LLM.

Stop after each phase and show me what was built before continuing.

## Acceptance checks

- `recommend({language: "Malayalam", genre: "Thriller"})` returns only Malayalam
  thrillers, every rating > 7.0, votes ≥ 1000, none of them in `watched`.
- After `mark_watched` on a returned movie, it never appears in `recommend` again.
- `mark_watched({title: "Drishyam"})` does **not** write anything; it returns the
  candidates (Malayalam 2013 and Hindi 2015 at least) for me to choose.
- `recommend({language: "ko"})` and `recommend({language: "Korean"})` give the same results.
- A failed or interrupted IMDb import leaves the previous catalogue fully intact.
- The full daily import completes without loading the raw files into memory.

## Open decisions (ask me before assuming)

- Hosting target for phase 4 (small VM, Fly.io, Railway, Cloudflare Workers + D1, etc.).
  This may change the SQLite-vs-Postgres choice.
- Whether to keep a TMDB key at all if Wikidata coverage turns out good enough.
