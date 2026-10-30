import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CATALOGUE_MIN_VOTES, DEFAULT_MIN_RATING, DEFAULT_MIN_VOTES } from "../config.js";
import { registerPrompts } from "./prompts.js";
import { MOODS, MOOD_NAMES } from "../shelf/moods.js";
import { IMDB_GENRES } from "../shelf/genres.js";
import {
  LIST_MAX_LIMIT,
  RECOMMEND_MAX_LIMIT,
  SEARCH_MAX_LIMIT,
  ShelfError,
  type ShelfService,
} from "../shelf/service.js";

export const SERVER_NAME = "movie-shelf";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Movie Shelf is the user's personal movie and TV-series database: IMDb ratings, what they have already watched, and a watchlist of titles they want to watch.
- To suggest movies, call \`recommend\` and present only movies it returns. Do not add movies from memory: results are already filtered to IMDb rating above ${DEFAULT_MIN_RATING.toFixed(1)} and exclude everything the user has watched.
- \`recommend\` returns movies by default; pass type="series" for TV series and miniseries, or type="any" for both. Series runtime_min is per episode.
- Show the rating, year, language and IMDb link from the tool result; never estimate ratings yourself.
- When the user says they watched something, call \`mark_watched\`. If it returns candidates instead of writing, ask the user which one they meant and call it again with that imdb_id.
- When the user wants to save a movie for later, call \`add_to_watchlist\`. When they ask what is on their list, or want to pick something from it, call \`list_watchlist\`. Marking a movie watched removes it from the watchlist automatically.`;

const languageParam = z
  .string()
  .min(1)
  .describe('Original language: ISO 639-1 code ("ml", "hi", "ta", "te", "ko", "ja", "en") or English name ("Malayalam", "Korean").');
const genreName = z.string().min(1).describe(`IMDb genre, case-insensitive: ${IMDB_GENRES.join(", ")}.`);
const genreParam = z
  .union([genreName, z.array(genreName).min(1).max(IMDB_GENRES.length)])
  .describe(
    `One IMDb genre or a list of genres, case-insensitive: ${IMDB_GENRES.join(", ")}. With a list, a movie must have ALL of them ` +
      `(["Sci-Fi", "Horror"] = sci-fi horror films). For "either/or", call once per genre.`,
  );
const excludeGenresParam = z
  .array(genreName)
  .max(IMDB_GENRES.length)
  .describe("IMDb genres to leave out: movies having ANY of these genres are excluded (e.g. [\"Drama\"] if the user dislikes drama).");
const keywordParam = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(5)])
  .describe(
    'TMDB keyword text, case-insensitive substring ("heist", "time travel", "based on true story", "serial killer"). With a list, a movie must match ALL. ' +
      "Only movies whose TMDB keywords have been imported can match, so an empty result may mean missing data rather than no such film.",
  );
const moodParam = z
  .string()
  .min(1)
  .describe(
    `Viewing mood: ${MOOD_NAMES.map((m) => `${m} (${MOODS[m].description})`).join("; ")}. ` +
      "A curated bundle of TMDB keywords (and some excluded genres), not an IMDb field; combine it freely with genre, language and years.",
  );
const typeParam = z
  .enum(["movie", "series", "any"])
  .describe(
    '"movie", "series" (TV series and miniseries) or "any" (both).',
  );
const imdbIdParam = z.string().min(1).describe('IMDb title ID, e.g. "tt0111161" (an IMDb URL also works).');
const yearParam = z.number().int().min(1870).max(2100);

/** Wraps a service call: JSON result on success, a tool error the model can read on bad input. */
async function run(fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    const value = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value as Record<string, unknown>,
    };
  } catch (err) {
    if (err instanceof ShelfError) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
    console.error("[movie-shelf] tool error:", err);
    return {
      isError: true,
      content: [{ type: "text", text: `Internal error: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
}

export function createMcpServer(service: ShelfService): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "recommend",
    {
      title: "Recommend movies",
      description:
        `Recommend movies the user has NOT watched yet, from real IMDb data. Every result is rated above ${DEFAULT_MIN_RATING.toFixed(1)} on IMDb ` +
        `and excludes the user's watched list. Use this whenever the user asks what to watch, optionally with a language, genre, mood, keyword or years. ` +
        `Returns total_matches (so you can say "showing 10 of 143") and per movie: title, year, language, genres, IMDb rating, votes, runtime and IMDb link, ` +
        `plus on_watchlist=true if the user already saved it to their watchlist. ` +
        `Use sort="shuffle" when the user asks again or wants something different.`,
      inputSchema: {
        language: languageParam.optional(),
        type: typeParam.describe('What to recommend: "movie" (default), "series" (TV series and miniseries) or "any" (both). Use "series" when the user asks for shows, series or binge-watching.').optional(),
        genre: genreParam.optional(),
        exclude_genres: excludeGenresParam.optional(),
        keyword: keywordParam.optional(),
        mood: moodParam.optional(),
        min_rating: z
          .number()
          .min(DEFAULT_MIN_RATING)
          .max(9.9)
          .optional()
          .describe(`Only movies rated strictly above this. Default ${DEFAULT_MIN_RATING.toFixed(1)}; can only be raised.`),
        min_votes: z
          .number()
          .int()
          .min(CATALOGUE_MIN_VOTES)
          .optional()
          .describe(`Minimum IMDb vote count. Default ${DEFAULT_MIN_VOTES}. Lower it (down to ${CATALOGUE_MIN_VOTES}) to include lesser-known films.`),
        year_from: yearParam.optional().describe("Earliest release year (inclusive)."),
        year_to: yearParam.optional().describe("Latest release year (inclusive)."),
        limit: z.number().int().min(1).max(RECOMMEND_MAX_LIMIT).optional().describe(`How many movies to return. Default 10, max ${RECOMMEND_MAX_LIMIT}.`),
        sort: z
          .enum(["top", "shuffle"])
          .optional()
          .describe('"top" (default): highest rated first, then most votes. "shuffle": random picks from all matches, for variety.'),
      },
      annotations: { title: "Recommend movies", readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(() => service.recommend(args)),
  );

  server.registerTool(
    "search_title",
    {
      title: "Search movies by title",
      description:
        "Find movies in the catalogue by title (English or original title). Use it to look up a specific movie, check its rating, " +
        "check whether the user already watched it, or tell apart movies with the same name (e.g. remakes). " +
        "Returns imdb_id, title, year, language, rating, votes, watched and on_watchlist (true/false) for each match, exact title matches first.",
      inputSchema: {
        query: z.string().min(1).describe("Movie title (or an IMDb ID/URL)."),
        year: yearParam.optional().describe("Release year, to narrow down same-named movies."),
        limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`Max results. Default 5, max ${SEARCH_MAX_LIMIT}.`),
      },
      annotations: { title: "Search movies by title", readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(() => service.searchTitle(args)),
  );

  server.registerTool(
    "mark_watched",
    {
      title: "Mark a movie as watched",
      description:
        "Add a movie to the user's watched list so it is never recommended again. Pass imdb_id when you have it (preferred), " +
        "otherwise title (plus year if known). With a title, the movie is saved only if exactly one movie has that title; " +
        'otherwise NOTHING is saved and the result has written=false and a list of candidates: ask the user which one they mean, ' +
        "then call again with its imdb_id. Calling it for an already-watched movie just updates the date/rating/notes. " +
        "A watched movie is removed from the watchlist automatically (removed_from_watchlist=true).",
      inputSchema: {
        imdb_id: imdbIdParam.optional(),
        title: z.string().min(1).optional().describe("Movie title, used when imdb_id is not known."),
        year: yearParam.optional().describe("Release year, helps pick the right movie when using title."),
        watched_on: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Date the user watched it, YYYY-MM-DD. Omit if unknown."),
        my_rating: z.number().min(1).max(10).optional().describe("The user's own rating, 1-10."),
        notes: z.string().max(2000).optional().describe("Free-text notes from the user."),
      },
      annotations: { title: "Mark a movie as watched", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => service.markWatched(args)),
  );

  server.registerTool(
    "unmark_watched",
    {
      title: "Remove a movie from the watched list",
      description:
        "Remove a movie from the user's watched list (e.g. it was marked by mistake), so it can be recommended again. Requires the imdb_id; use search_title or list_watched to find it.",
      inputSchema: { imdb_id: imdbIdParam },
      annotations: { title: "Remove from watched list", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => service.unmarkWatched(args)),
  );

  server.registerTool(
    "list_watched",
    {
      title: "List watched movies",
      description:
        "List the movies the user has watched, newest first, with their own rating, date and notes. Optionally filter by language, genre or a title search. " +
        "Entries not in the catalogue have title=null and in_catalogue=false; show their imdb_url instead. Use offset to page through long lists.",
      inputSchema: {
        language: languageParam.optional(),
        type: typeParam.optional().describe('Only movies, only series, or both (default: both).'),
        genre: genreParam.optional(),
        exclude_genres: excludeGenresParam.optional(),
        query: z.string().optional().describe("Filter by words in the title (or an exact IMDb ID)."),
        limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional().describe(`Default 50, max ${LIST_MAX_LIMIT}.`),
        offset: z.number().int().min(0).optional().describe("Skip this many entries (for paging). Default 0."),
      },
      annotations: { title: "List watched movies", readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(() => service.listWatched(args)),
  );

  server.registerTool(
    "add_to_watchlist",
    {
      title: "Add a movie to the watchlist",
      description:
        "Save a movie the user wants to watch later. Pass imdb_id when you have it (preferred), otherwise title (plus year if known). " +
        "With a title, the movie is saved only if exactly one movie has that title; otherwise NOTHING is saved and the result has " +
        "written=false and candidates: ask the user which one they mean, then call again with its imdb_id. " +
        "Movies the user already watched are not added (status already_watched). Adding a movie that is already on the list updates its notes.",
      inputSchema: {
        imdb_id: imdbIdParam.optional(),
        title: z.string().min(1).optional().describe("Movie title, used when imdb_id is not known."),
        year: yearParam.optional().describe("Release year, helps pick the right movie when using title."),
        notes: z.string().max(2000).optional().describe('Why it was saved, e.g. "recommended by Arun".'),
      },
      annotations: { title: "Add to watchlist", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => service.addToWatchlist(args)),
  );

  server.registerTool(
    "remove_from_watchlist",
    {
      title: "Remove a movie from the watchlist",
      description:
        "Remove a movie from the user's watchlist without marking it watched (e.g. they lost interest). Requires the imdb_id; " +
        "use list_watchlist to find it. To record that they watched it, call mark_watched instead (that also removes it from the watchlist).",
      inputSchema: { imdb_id: imdbIdParam },
      annotations: { title: "Remove from watchlist", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => run(() => service.removeFromWatchlist(args)),
  );

  server.registerTool(
    "list_watchlist",
    {
      title: "List the watchlist",
      description:
        "List movies the user saved to watch later, with notes, IMDb rating, language, genres and runtime. Optionally filter by language, " +
        'genre or a title search. Use sort="rating" to pick the best-rated one for tonight. Entries not in the catalogue have ' +
        "title=null and in_catalogue=false; show their imdb_url instead.",
      inputSchema: {
        language: languageParam.optional(),
        type: typeParam.optional().describe('Only movies, only series, or both (default: both).'),
        genre: genreParam.optional(),
        exclude_genres: excludeGenresParam.optional(),
        query: z.string().optional().describe("Filter by words in the title (or an exact IMDb ID)."),
        sort: z.enum(["added", "rating"]).optional().describe('"added" (default): most recently saved first. "rating": highest IMDb rating first.'),
        limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional().describe(`Default 50, max ${LIST_MAX_LIMIT}.`),
        offset: z.number().int().min(0).optional().describe("Skip this many entries (for paging). Default 0."),
      },
      annotations: { title: "List watchlist", readOnlyHint: true, openWorldHint: false },
    },
    (args) => run(() => service.listWatchlist(args)),
  );

  registerPrompts(server);

  return server;
}
