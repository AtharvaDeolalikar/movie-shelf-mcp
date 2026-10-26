import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MovieRow } from "../src/db/repository.js";
import type { Db } from "../src/db/sqlite.js";
import { openDatabase } from "../src/db/sqlite.js";
import {
  SqliteCatalogueRepository,
  SqliteImportRunRepository,
  SqliteKeywordRepository,
} from "../src/db/sqlite-repository.js";
import { importTmdbKeywords } from "../src/keywords/import.js";
import { TmdbClient } from "../src/languages/tmdb.js";

const movie = (imdb_id: string, rating: number, votes: number): MovieRow => ({
  imdb_id,
  title: imdb_id,
  original_title: null,
  year: 2000,
  runtime_min: 100,
  genres: "Drama",
  rating,
  votes,
  title_type: "movie",
  end_year: null,
});

describe("TMDB keyword import", () => {
  let db: Db;
  let keywords: SqliteKeywordRepository;
  let runs: SqliteImportRunRepository;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    keywords = new SqliteKeywordRepository(db);
    runs = new SqliteImportRunRepository(db);
    const catalogue = new SqliteCatalogueRepository(db);
    await catalogue.beginStaging();
    await catalogue.insertStaging([
      movie("tt0000001", 8.0, 50000),
      movie("tt0000002", 8.0, 20000),
      movie("tt0000003", 6.5, 90000), // below the rating floor
      movie("tt0000004", 8.0, 500), // below the vote floor
    ]);
    await catalogue.swapStaging();
  });
  afterEach(() => db.close());

  const stored = (id: string) =>
    db.prepare("SELECT keyword FROM movie_keyword WHERE imdb_id = ? ORDER BY keyword").pluck().all(id);

  it("looks up each eligible movie once, retries misses only after the window, replaces keywords", async () => {
    const asked: string[] = [];
    const client = {
      async findKeywords(id: string) {
        asked.push(id);
        return id === "tt0000001"
          ? { status: "found" as const, keywords: ["heist", "twist"] }
          : { status: "not_found" as const };
      },
    };
    const opts = { keywords, runs, client, minRating: 7.0, minVotes: 1000 };

    const r = await importTmdbKeywords(opts);
    assert.deepEqual(asked, ["tt0000001", "tt0000002"]); // most-voted first; others fail the filter
    assert.deepEqual([r.found, r.notFound], [1, 1]);
    assert.deepEqual(stored("tt0000001"), ["heist", "twist"]);

    asked.length = 0;
    await importTmdbKeywords(opts);
    assert.deepEqual(asked, []);

    await importTmdbKeywords({ ...opts, now: () => new Date(Date.now() + 31 * 86_400_000) });
    assert.deepEqual(asked, ["tt0000002"]); // successes are never re-queried

    await keywords.recordKeywords("tt0000001", "found", ["twist"], new Date().toISOString());
    assert.deepEqual(stored("tt0000001"), ["twist"]);
    assert.equal((await runs.latestRuns("keywords", 1))[0]?.status, "success");

    const c = await keywords.keywordCoverage({ minRating: 7.0, minVotes: 1000, top: 5 });
    assert.deepEqual([c.movies, c.withKeywords], [2, 1]);
    assert.deepEqual(c.topKeywords, [{ keyword: "twist", movies: 1 }]);
  });
});

describe("TmdbClient.findKeywords", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const client = (handler: (url: URL) => Response) =>
    new TmdbClient({
      apiKey: "abc123",
      userAgent: "test",
      baseUrl: "http://tmdb.test/3",
      sleep: async () => {},
      requestsPerSecond: 1e9,
      fetch: (async (url: URL) => handler(new URL(url))) as typeof fetch,
    });

  it("finds the TMDB id, then reads lowercased, deduplicated keywords", async () => {
    const paths: string[] = [];
    const c = client((url) => {
      paths.push(url.pathname);
      return url.pathname.startsWith("/3/find/")
        ? json({ movie_results: [{ id: 603 }] })
        : json({ id: 603, keywords: [{ name: "Dystopia" }, { name: "dystopia" }, { name: " AI " }, {}] });
    });
    assert.deepEqual(await c.findKeywords("tt0133093"), { status: "found", keywords: ["dystopia", "ai"] });
    assert.deepEqual(paths, ["/3/find/tt0133093", "/3/movie/603/keywords"]);
  });

  it("uses the TV endpoints for series (tv_results, `results` key)", async () => {
    const paths: string[] = [];
    const c = client((url) => {
      paths.push(url.pathname);
      return url.pathname.startsWith("/3/find/")
        ? json({ movie_results: [], tv_results: [{ id: 1396, original_language: "en" }] })
        : json({ id: 1396, results: [{ name: "Drug Lord" }, { name: "chemistry teacher" }] });
    });
    assert.deepEqual(await c.findKeywords("tt0903747"), { status: "found", keywords: ["drug lord", "chemistry teacher"] });
    assert.deepEqual(paths, ["/3/find/tt0903747", "/3/tv/1396/keywords"]);
    assert.deepEqual(await c.findOriginalLanguage("tt0903747"), { status: "found", lang: "en" });
  });

  it("reports not_found when TMDB has no movie, and found with no keywords for a bare entry", async () => {
    assert.deepEqual(await client(() => json({ movie_results: [] })).findKeywords("tt1"), { status: "not_found" });
    assert.deepEqual(await client(() => json({}, 404)).findKeywords("tt1"), { status: "not_found" });
    const bare = client((url) => (url.pathname.startsWith("/3/find/") ? json({ movie_results: [{ id: 1 }] }) : json({ id: 1 })));
    assert.deepEqual(await bare.findKeywords("tt1"), { status: "found", keywords: [] });
  });
});
