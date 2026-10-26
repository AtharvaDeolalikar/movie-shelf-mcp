import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (this file lives in src/ or dist/). Relative paths resolve against it, not the cwd. */
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export interface Config {
  /** SQLite database file. */
  dbPath: string;
  /** Base URL of the IMDb non-commercial datasets. */
  imdbBaseUrl: string;
  wikidataEndpoint: string;
  /** Wikimedia asks API clients for a descriptive User-Agent. */
  userAgent: string;
  /** TMDB v3 API key or v4 read access token; TMDB fallback is skipped when unset. */
  tmdbApiKey: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dbPath: path.resolve(PROJECT_ROOT, env.MOVIE_SHELF_DB ?? path.join("data", "movie-shelf.db")),
    imdbBaseUrl: (env.IMDB_DATASETS_URL ?? "https://datasets.imdbws.com").replace(/\/+$/, ""),
    wikidataEndpoint: env.WIKIDATA_SPARQL_URL ?? "https://query.wikidata.org/sparql",
    userAgent: env.HTTP_USER_AGENT ?? "movie-shelf-mcp/0.1 (personal non-commercial project)",
    tmdbApiKey: env.TMDB_API_KEY?.trim() || undefined,
  };
}

/**
 * Vote floor applied at import time. Kept deliberately low so the recommend
 * threshold can change without re-importing.
 */
export const CATALOGUE_MIN_VOTES = 100;

/** Defaults of the `recommend` tool; also scope the TMDB language fallback. */
export const DEFAULT_MIN_RATING = 7.0;
export const DEFAULT_MIN_VOTES = 1000;
