/**
 * npm run import:languages [-- options]
 *
 *   --wikidata auto|always|never   bulk Wikidata job; `auto` (default) runs it
 *                                  only if the last success is >= 6 days old
 *   --skip-tmdb                    skip the TMDB per-title fallback
 *   --tmdb-limit <n>               cap TMDB lookups this run
 *   --tmdb-retry-days <n>          re-query TMDB misses older than n days (30)
 *   --force                        apply a Wikidata result even if it shrank by >50%
 *
 * Run after `npm run import:imdb`: the TMDB fallback only considers movies in
 * the catalogue that pass the default recommend filter.
 */
import { parseArgs } from "node:util";
import { DEFAULT_MIN_RATING, DEFAULT_MIN_VOTES, loadConfig } from "../config.js";
import type { ImportKind } from "../db/repository.js";
import { openDatabase } from "../db/sqlite.js";
import { SqliteImportRunRepository, SqliteLanguageRepository } from "../db/sqlite-repository.js";
import { languageName } from "../languages/normalise.js";
import { TmdbClient, importTmdbLanguages } from "../languages/tmdb.js";
import { importWikidataLanguages } from "../languages/wikidata.js";

const WIKIDATA_REFRESH_DAYS = 6;

const { values } = parseArgs({
  options: {
    wikidata: { type: "string", default: "auto" },
    "skip-tmdb": { type: "boolean", default: false },
    "tmdb-limit": { type: "string" },
    "tmdb-retry-days": { type: "string", default: "30" },
    force: { type: "boolean", default: false },
  },
});

const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);
const fail = (msg: string): never => {
  log(msg);
  process.exit(2);
};

const wikidataMode = values.wikidata;
if (!["auto", "always", "never"].includes(wikidataMode)) fail(`Invalid --wikidata: ${wikidataMode}`);
const tmdbLimit = values["tmdb-limit"] === undefined ? undefined : Number(values["tmdb-limit"]);
if (tmdbLimit !== undefined && !(Number.isInteger(tmdbLimit) && tmdbLimit >= 0)) fail("Invalid --tmdb-limit");
const retryDays = Number(values["tmdb-retry-days"]);
if (!(Number.isFinite(retryDays) && retryDays >= 0)) fail("Invalid --tmdb-retry-days");

const config = loadConfig();
const db = openDatabase(config.dbPath);
const runs = new SqliteImportRunRepository(db);
const languages = new SqliteLanguageRepository(db);
log(`Database: ${config.dbPath}`);

// Ctrl-C / SIGTERM: record the in-flight run as interrupted. Wikidata writes
// in one transaction at the very end and TMDB lookups are stored one by one,
// so there is never a partial state to roll back.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log(`${signal} received; stopping.`);
    for (const kind of ["wikidata", "tmdb"] as ImportKind[]) {
      const [latest] = await runs.latestRuns(kind, 1);
      if (latest?.status === "running") await runs.finishRun(latest.id, { status: "interrupted", error: signal });
    }
    db.close();
    process.exit(130);
  });
}

let exitCode = 0;
try {
  if (await movieCount() === 0) {
    log("Warning: the movie catalogue is empty; run `npm run import:imdb` first for the TMDB fallback and report.");
  }

  // 1. Wikidata bulk job
  if (await shouldRunWikidata()) {
    try {
      await importWikidataLanguages({
        languages,
        runs,
        client: { endpoint: config.wikidataEndpoint, userAgent: config.userAgent },
        force: values.force,
        log,
      });
    } catch (err) {
      // Previous Wikidata data stays in place; still try the TMDB fallback.
      exitCode = 1;
      log(`Wikidata import FAILED: ${errMessage(err)} (existing languages unchanged)`);
    }
  } else {
    log(`Wikidata: skipped (--wikidata ${wikidataMode})`);
  }

  // 2. TMDB fallback
  if (values["skip-tmdb"]) {
    log("TMDB: skipped (--skip-tmdb)");
  } else if (!config.tmdbApiKey) {
    log("TMDB: skipped (TMDB_API_KEY not set)");
  } else {
    try {
      await importTmdbLanguages({
        languages,
        runs,
        client: new TmdbClient({ apiKey: config.tmdbApiKey, userAgent: config.userAgent }),
        minRating: DEFAULT_MIN_RATING,
        minVotes: DEFAULT_MIN_VOTES,
        retryAfterDays: retryDays,
        ...(tmdbLimit !== undefined ? { limit: tmdbLimit } : {}),
        log,
      });
    } catch (err) {
      exitCode = 1;
      log(`TMDB fallback FAILED: ${errMessage(err)} (lookups so far are kept)`);
    }
  }

  await report();
} finally {
  db.close();
}
process.exit(exitCode);

async function shouldRunWikidata(): Promise<boolean> {
  if (wikidataMode === "always") return true;
  if (wikidataMode === "never") return false;
  const recent = await runs.latestRuns("wikidata", 20);
  const lastSuccess = recent.find((r) => r.status === "success");
  if (!lastSuccess) return true;
  const ageDays = (Date.now() - Date.parse(lastSuccess.started_at)) / 86_400_000;
  if (ageDays >= WIKIDATA_REFRESH_DAYS) return true;
  log(`Wikidata: last success ${ageDays.toFixed(1)} days ago; skipping (use --wikidata always to force)`);
  return false;
}

async function movieCount(): Promise<number> {
  return db.prepare("SELECT COUNT(*) FROM movies").pluck().get() as number;
}

async function report(): Promise<void> {
  const c = await languages.coverage({ minRating: DEFAULT_MIN_RATING, minVotes: DEFAULT_MIN_VOTES, top: 15 });
  const pct = c.movies ? ((100 * c.withLanguage) / c.movies).toFixed(1) : "0";
  log(`Coverage (rating > ${DEFAULT_MIN_RATING}, votes >= ${DEFAULT_MIN_VOTES}): ${c.withLanguage.toLocaleString()}/${c.movies.toLocaleString()} movies (${pct}%)`);
  log(`  by source: wikidata ${c.bySource.wikidata}, tmdb ${c.bySource.tmdb}, manual ${c.bySource.manual}`);
  log(`  top languages: ${c.topLanguages.map((l) => `${languageName(l.lang)} (${l.lang}) ${l.movies}`).join(", ")}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
