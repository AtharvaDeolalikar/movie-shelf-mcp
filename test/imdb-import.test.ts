import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import type { Db } from "../src/db/sqlite.js";
import { openDatabase } from "../src/db/sqlite.js";
import { SqliteCatalogueRepository, SqliteImportRunRepository } from "../src/db/sqlite-repository.js";
import { importImdb } from "../src/imdb/import.js";
import { directorySource } from "../src/imdb/tsv.js";

const BASICS_HEADER =
  "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres";
const RATINGS_HEADER = "tconst\taverageRating\tnumVotes";

const basicsRows = [
  // kept
  "tt3417422\tmovie\tDrishyam\tDrishyam\t0\t2013\t\\N\t160\tCrime,Drama,Thriller",
  "tt4430212\tmovie\tDrishyam\tDrishyam\t0\t2015\t\\N\t163\tCrime,Drama,Mystery",
  "tt0111161\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t142\tDrama",
  "tt9999001\tmovie\tNo Year\tOriginal Name\t0\t\\N\t\\N\t\\N\t\\N",
  // kept: series carry their end year
  "tt0903747\ttvSeries\tBreaking Bad\tBreaking Bad\t0\t2008\t2013\t45\tCrime,Drama,Thriller",
  // dropped: not a movie or series
  "tt9999006\ttvEpisode\tOzymandias\tOzymandias\t0\t2013\t\\N\t47\tCrime,Drama,Thriller",
  "tt9999007\tvideoGame\tSome Game\tSome Game\t0\t2013\t\\N\t\\N\tAction",
  // dropped: adult
  "tt9999002\tmovie\tAdult Film\tAdult Film\t1\t2010\t\\N\t90\tDrama",
  // dropped: too few votes
  "tt9999003\tmovie\tObscure\tObscure\t0\t2011\t\\N\t90\tDrama",
  // dropped: no rating
  "tt9999004\tmovie\tUnrated\tUnrated\t0\t2012\t\\N\t90\tDrama",
  // malformed (missing columns)
  "tt9999005\tmovie\tBroken",
];
const ratingsRows = [
  "tt3417422\t8.3\t95000",
  "tt4430212\t8.2\t110000",
  "tt0111161\t9.3\t3000000",
  "tt9999001\t6.5\t100",
  "tt0903747\t9.5\t2200000",
  "tt9999006\t9.9\t200000",
  "tt9999007\t9.0\t50000",
  "tt9999002\t7.0\t5000",
  "tt9999003\t8.0\t99",
];

function writeDataset(dir: string, basics: string[], ratings: string[]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "title.basics.tsv.gz"),
    gzipSync([BASICS_HEADER, ...basics].join("\n") + "\n"),
  );
  fs.writeFileSync(
    path.join(dir, "title.ratings.tsv.gz"),
    gzipSync([RATINGS_HEADER, ...ratings].join("\n") + "\n"),
  );
}

describe("IMDb import", () => {
  let tmp: string;
  let db: Db;
  let catalogue: SqliteCatalogueRepository;
  let runs: SqliteImportRunRepository;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "movie-shelf-test-"));
    db = openDatabase(path.join(tmp, "test.db"));
    catalogue = new SqliteCatalogueRepository(db);
    runs = new SqliteImportRunRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (dir: string, extra: { force?: boolean } = {}) =>
    importImdb({ catalogue, runs, source: directorySource(dir), ...extra });

  it("keeps only rated, non-adult movies and series at or above the vote floor", async () => {
    const dir = path.join(tmp, "ok");
    writeDataset(dir, basicsRows, ratingsRows);

    const result = await run(dir);

    assert.equal(result.rows, 5);
    assert.equal(result.malformedLines, 1);
    const ids = db.prepare("SELECT imdb_id FROM movies ORDER BY imdb_id").pluck().all();
    assert.deepEqual(ids, ["tt0111161", "tt0903747", "tt3417422", "tt4430212", "tt9999001"]);

    const drishyam = db.prepare("SELECT * FROM movies WHERE imdb_id = 'tt3417422'").get();
    assert.deepEqual(drishyam, {
      imdb_id: "tt3417422",
      title: "Drishyam",
      original_title: null, // same as title, not duplicated
      year: 2013,
      runtime_min: 160,
      genres: "Crime,Drama,Thriller",
      rating: 8.3,
      votes: 95000,
      title_norm: "drishyam",
      original_norm: null,
      title_type: "movie",
      end_year: null,
    });

    const series = db.prepare("SELECT title_type, year, end_year FROM movies WHERE imdb_id = 'tt0903747'").get();
    assert.deepEqual(series, { title_type: "tvSeries", year: 2008, end_year: 2013 });

    const noYear = db.prepare("SELECT * FROM movies WHERE imdb_id = 'tt9999001'").get() as Record<string, unknown>;
    assert.equal(noYear.year, null);
    assert.equal(noYear.runtime_min, null);
    assert.equal(noYear.genres, null);
    assert.equal(noYear.original_title, "Original Name");

    const [latest] = await runs.latestRuns("imdb", 1);
    assert.equal(latest?.status, "success");
    assert.equal(latest?.rows, 5);
  });

  it("leaves the previous catalogue intact when the download is truncated", async () => {
    const good = path.join(tmp, "good");
    writeDataset(good, basicsRows, ratingsRows);
    await run(good);
    const before = db.prepare("SELECT * FROM movies ORDER BY imdb_id").all();

    // Same data but the basics gzip is cut off mid-stream.
    const bad = path.join(tmp, "bad");
    const many = Array.from({ length: 20_000 }, (_, i) =>
      `tt${String(8_000_000 + i)}\tmovie\tFiller ${i}\tFiller ${i}\t0\t2000\t\\N\t90\tDrama`,
    );
    writeDataset(bad, [...basicsRows, ...many], ratingsRows);
    const gz = fs.readFileSync(path.join(bad, "title.basics.tsv.gz"));
    fs.writeFileSync(path.join(bad, "title.basics.tsv.gz"), gz.subarray(0, Math.floor(gz.length / 2)));

    await assert.rejects(run(bad), /unexpected end of file/i);

    assert.deepEqual(db.prepare("SELECT * FROM movies ORDER BY imdb_id").all(), before);
    assert.equal(
      db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'movies_staging'").pluck().get(),
      0,
    );
    const [latest] = await runs.latestRuns("imdb", 1);
    assert.equal(latest?.status, "failed");
    assert.match(latest?.error ?? "", /unexpected end of file/i);
  });

  it("rejects a changed file format without touching the catalogue", async () => {
    const good = path.join(tmp, "good");
    writeDataset(good, basicsRows, ratingsRows);
    await run(good);

    const bad = path.join(tmp, "bad");
    writeDataset(bad, basicsRows, ratingsRows);
    fs.writeFileSync(
      path.join(bad, "title.ratings.tsv.gz"),
      gzipSync("tconst\trating\tvotes\ntt0111161\t9.3\t3000000\n"),
    );

    await assert.rejects(run(bad), /Unexpected IMDb header/);
    assert.equal(await catalogue.countMovies(), 5);
  });

  it("refuses to swap in a catalogue that shrank by more than half unless forced", async () => {
    const good = path.join(tmp, "good");
    writeDataset(good, basicsRows, ratingsRows);
    await run(good);

    const tiny = path.join(tmp, "tiny");
    writeDataset(tiny, basicsRows.slice(0, 1), ratingsRows);
    await assert.rejects(run(tiny), /refusing to swap/);
    assert.equal(await catalogue.countMovies(), 5);

    const forced = await run(tiny, { force: true });
    assert.equal(forced.rows, 1);
    assert.equal(await catalogue.countMovies(), 1);
  });

  it("marks a run left 'running' by a crashed process as interrupted and cleans leftover staging", async () => {
    const crashedId = await runs.startRun("imdb");
    await catalogue.beginStaging();
    await catalogue.insertStaging([
      { imdb_id: "tt1", title: "Partial", original_title: null, year: null, runtime_min: null, genres: null, rating: 8, votes: 500, title_type: "movie", end_year: null },
    ]);

    const good = path.join(tmp, "good");
    writeDataset(good, basicsRows, ratingsRows);
    await run(good);

    const all = await runs.latestRuns("imdb", 10);
    assert.equal(all.find((r) => r.id === crashedId)?.status, "interrupted");
    assert.equal(await catalogue.countMovies(), 5);
    assert.equal(db.prepare("SELECT COUNT(*) FROM movies WHERE imdb_id = 'tt1'").pluck().get(), 0);
  });

  it("staging table has exactly the columns the migrations give `movies`", async () => {
    const columns = (table: string) =>
      db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY name`).all(table);
    const migrated = columns("movies");
    await catalogue.beginStaging();
    assert.deepEqual(columns("movies_staging"), migrated);
    await catalogue.discardStaging();
  });

  it("does not touch the watched list or language table on swap", async () => {
    db.prepare("INSERT INTO watched (imdb_id, added_via) VALUES ('tt0000001', 'mcp')").run();
    db.prepare(
      "INSERT INTO movie_language (imdb_id, lang, source, fetched_at) VALUES ('tt3417422', 'ml', 'manual', '2026-01-01')",
    ).run();

    const good = path.join(tmp, "good");
    writeDataset(good, basicsRows, ratingsRows);
    await run(good);
    await run(good);

    assert.equal(db.prepare("SELECT COUNT(*) FROM watched").pluck().get(), 1);
    assert.equal(db.prepare("SELECT lang FROM movie_language").pluck().get(), "ml");
  });
});
