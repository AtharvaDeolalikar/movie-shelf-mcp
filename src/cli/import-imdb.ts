/**
 * npm run import:imdb [-- --dir <path>] [--force] [--min-votes <n>]
 *
 *   --dir <path>      read title.basics.tsv.gz / title.ratings.tsv.gz from a local
 *                     directory instead of downloading them
 *   --force           swap even if the catalogue shrinks by more than half
 *   --min-votes <n>   vote floor stored in the catalogue (default 100)
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/sqlite.js";
import { SqliteCatalogueRepository, SqliteImportRunRepository } from "../db/sqlite-repository.js";
import { importImdb } from "../imdb/import.js";
import { directorySource, httpSource } from "../imdb/tsv.js";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    force: { type: "boolean", default: false },
    "min-votes": { type: "string" },
  },
});

const config = loadConfig();
const db = openDatabase(config.dbPath);
const catalogue = new SqliteCatalogueRepository(db);
const runs = new SqliteImportRunRepository(db);
const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);

let runId: number | undefined;

// Ctrl-C / SIGTERM: drop staging, record the run as interrupted. The live
// catalogue is never touched before the final swap, so it stays intact.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log(`${signal} received; aborting import, previous catalogue left intact.`);
    await catalogue.discardStaging();
    if (runId !== undefined) await runs.finishRun(runId, { status: "interrupted", error: signal });
    db.close();
    process.exit(130);
  });
}

const minVotes = values["min-votes"] !== undefined ? Number(values["min-votes"]) : undefined;
if (minVotes !== undefined && !(Number.isInteger(minVotes) && minVotes >= 0)) {
  log(`Invalid --min-votes: ${values["min-votes"]}`);
  process.exit(2);
}

log(`Database: ${config.dbPath}`);
log(`Source: ${values.dir ?? config.imdbBaseUrl}`);
const started = Date.now();
try {
  const result = await importImdb({
    catalogue,
    runs,
    source: values.dir ? directorySource(values.dir) : httpSource(config.imdbBaseUrl),
    force: values.force,
    log,
    onRunStarted: (id) => (runId = id),
    ...(minVotes !== undefined ? { minVotes } : {}),
  });
  log(
    `Done in ${((Date.now() - started) / 1000).toFixed(1)}s: run #${result.runId}, ` +
      `${result.rows.toLocaleString()} movies` +
      (result.malformedLines ? `, ${result.malformedLines} malformed lines skipped` : ""),
  );
  db.close();
} catch (err) {
  log(`Import FAILED: ${err instanceof Error ? err.message : String(err)}`);
  log("The previous catalogue is unchanged.");
  db.close();
  process.exit(1);
}
