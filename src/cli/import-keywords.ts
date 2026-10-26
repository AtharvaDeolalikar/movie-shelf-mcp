/**
 * npm run import:keywords [-- options]
 *
 *   --limit <n>          cap TMDB lookups this run
 *   --retry-days <n>     re-query TMDB misses older than n days (30)
 *
 * Needs TMDB_API_KEY. Run after `npm run import:imdb`; only movies passing the
 * default recommend filter are looked up. Safe to interrupt and re-run.
 */
import { parseArgs } from "node:util";
import { DEFAULT_MIN_RATING, DEFAULT_MIN_VOTES, loadConfig } from "../config.js";
import { openDatabase } from "../db/sqlite.js";
import { SqliteImportRunRepository, SqliteKeywordRepository } from "../db/sqlite-repository.js";
import { importTmdbKeywords } from "../keywords/import.js";
import { TmdbClient } from "../languages/tmdb.js";

const { values } = parseArgs({
  options: {
    limit: { type: "string" },
    "retry-days": { type: "string", default: "30" },
  },
});

const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);
const fail = (msg: string): never => {
  log(msg);
  process.exit(2);
};

const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) fail("Invalid --limit");
const retryDays = Number(values["retry-days"]);
if (!(Number.isFinite(retryDays) && retryDays >= 0)) fail("Invalid --retry-days");

const config = loadConfig();
if (!config.tmdbApiKey) fail("TMDB_API_KEY is not set.");

const db = openDatabase(config.dbPath);
const runs = new SqliteImportRunRepository(db);
const keywords = new SqliteKeywordRepository(db);
log(`Database: ${config.dbPath}`);

// Lookups are stored one by one, so there is no partial state to roll back.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log(`${signal} received; stopping.`);
    const [latest] = await runs.latestRuns("keywords", 1);
    if (latest?.status === "running") await runs.finishRun(latest.id, { status: "interrupted", error: signal });
    db.close();
    process.exit(130);
  });
}

let exitCode = 0;
try {
  await importTmdbKeywords({
    keywords,
    runs,
    client: new TmdbClient({ apiKey: config.tmdbApiKey!, userAgent: config.userAgent }),
    minRating: DEFAULT_MIN_RATING,
    minVotes: DEFAULT_MIN_VOTES,
    retryAfterDays: retryDays,
    ...(limit !== undefined ? { limit } : {}),
    log,
  });
  const c = await keywords.keywordCoverage({ minRating: DEFAULT_MIN_RATING, minVotes: DEFAULT_MIN_VOTES, top: 20 });
  const pct = c.movies ? ((100 * c.withKeywords) / c.movies).toFixed(1) : "0";
  log(`Coverage (rating > ${DEFAULT_MIN_RATING}, votes >= ${DEFAULT_MIN_VOTES}): ${c.withKeywords.toLocaleString()}/${c.movies.toLocaleString()} movies (${pct}%)`);
  log(`  top keywords: ${c.topKeywords.map((k) => `${k.keyword} ${k.movies}`).join(", ")}`);
} catch (err) {
  exitCode = 1;
  log(`TMDB keywords FAILED: ${err instanceof Error ? err.message : String(err)} (lookups so far are kept)`);
} finally {
  db.close();
}
process.exit(exitCode);
