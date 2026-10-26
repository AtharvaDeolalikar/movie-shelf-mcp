/**
 * Bulk-import watch history, or a watchlist.
 *
 *   npm run import:watched -- --csv ratings.csv     IMDb "Your Ratings" export
 *   npm run import:watched -- --text watched.txt    one title per line, optional year
 *   add --list watchlist to fill the watchlist instead (e.g. from IMDb's
 *     watchlist export, which has the same Const / Title Type columns)
 *   add --dry-run to see what would be written without writing
 *
 * Text lines are resolved exactly like mark_watched: only a single exact
 * title match (within the year, if given) is written. Ambiguous and
 * unmatched lines are printed so you can fix them by hand (add a year, or
 * replace the line with an IMDb ID / URL).
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { createShelfService } from "../app.js";
import { loadConfig } from "../config.js";
import type { WatchedInput } from "../db/repository.js";
import { openDatabase } from "../db/sqlite.js";
import { parseImdbId } from "../lib/text.js";
import type { SearchHit } from "../shelf/service.js";
import { parseTitleList, planImdbRatingsCsv } from "../watched/parse.js";

const { values } = parseArgs({
  options: {
    csv: { type: "string" },
    text: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    list: { type: "string", default: "watched" },
  },
});

if (!values.csv === !values.text || !["watched", "watchlist"].includes(values.list)) {
  console.error(
    "Usage: npm run import:watched -- (--csv <ratings.csv> | --text <titles.txt>) [--list watched|watchlist] [--dry-run]",
  );
  process.exit(2);
}
const toWatchlist = values.list === "watchlist";

const dryRun = values["dry-run"];
const config = loadConfig();
const db = openDatabase(config.dbPath);
const service = createShelfService(db);
/** Writes to the chosen list and prints the outcome. */
async function write(entries: WatchedInput[]): Promise<void> {
  if (toWatchlist) {
    const r = await service.importWatchlist(entries.map(({ imdb_id, year, added_via }) => ({ imdb_id, year: year ?? null, added_via })));
    console.log(`Watchlist: added ${r.created} new, updated ${r.updated} existing.`);
    if (r.alreadyWatched.length) console.log(`Skipped ${r.alreadyWatched.length} already watched: ${r.alreadyWatched.join(", ")}`);
  } else {
    const r = await service.importWatched(entries);
    console.log(`Watched: wrote ${r.created} new, updated ${r.updated} existing` +
      (r.removedFromWatchlist ? `, removed ${r.removedFromWatchlist} from the watchlist.` : "."));
  }
}

const describe = (h: SearchHit) =>
  `${h.title} (${h.year ?? "?"}) ${h.imdb_id} · ${h.language ?? "language unknown"} · ★${h.rating} · ${h.votes.toLocaleString()} votes`;

try {
  if (values.csv) {
    const plan = planImdbRatingsCsv(fs.readFileSync(values.csv, "utf8"));
    console.log(`IMDb CSV: ${plan.entries.length} movies to import into ${values.list}, ${plan.skipped.length} rows skipped.`);
    for (const s of plan.skipped) console.log(`  skipped line ${s.line}: ${s.title || "(no title)"} (${s.reason})`);
    if (!dryRun) await write(plan.entries);
  } else {
    const lines = parseTitleList(fs.readFileSync(values.text!, "utf8"));
    const toWrite: WatchedInput[] = [];
    const matched: string[] = [];
    const problems: string[] = [];

    for (const l of lines) {
      const id = parseImdbId(l.raw);
      if (id) {
        toWrite.push({ imdb_id: id, ...(l.year ? { year: l.year } : {}), added_via: "import" });
        matched.push(`  line ${l.line}: ${l.raw} -> ${id}`);
        continue;
      }
      const r = await service.resolveTitle(l.title, l.year);
      if (r.status === "match") {
        toWrite.push({ imdb_id: r.movie.imdb_id, year: r.movie.year, added_via: "import" });
        matched.push(`  line ${l.line}: ${l.raw} -> ${describe(r.movie)}`);
      } else {
        const label = { ambiguous: "AMBIGUOUS", needs_confirmation: "NO EXACT MATCH", not_found: "NOT FOUND" }[r.status];
        problems.push(`  line ${l.line}: ${l.raw}  [${label}]`);
        for (const c of r.candidates) problems.push(`      ${describe(c)}`);
      }
    }

    console.log(`Matched ${matched.length} of ${lines.length} lines:`);
    matched.forEach((m) => console.log(m));
    if (problems.length) {
      console.log(`\nNeeds fixing by hand (${lines.length - matched.length} lines; add a year or replace with an IMDb ID/URL):`);
      problems.forEach((p) => console.log(p));
    }
    if (!dryRun) {
      console.log("");
      await write(toWrite);
    }
  }
  if (dryRun) console.log("\n(dry run: nothing written)");
} finally {
  db.close();
}
