import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createShelfService } from "../src/app.js";
import type { MovieRow } from "../src/db/repository.js";
import type { Db } from "../src/db/sqlite.js";
import { openDatabase } from "../src/db/sqlite.js";
import { SqliteCatalogueRepository } from "../src/db/sqlite-repository.js";
import { createMcpServer } from "../src/mcp/server.js";

type Movie = [id: string, title: string, year: number, genres: string, rating: number, votes: number, lang: string | null, original?: string];

// Synthetic catalogue; the two Drishyams use their real IDs.
const MOVIES: Movie[] = [
  ["tt3417422", "Drishyam", 2013, "Crime,Drama,Thriller", 8.4, 50000, "ml"],
  ["tt4430212", "Drishyam", 2015, "Crime,Drama,Mystery", 8.2, 112000, "hi"],
  ["tt0000001", "Mal Thriller Top", 1987, "Thriller", 8.9, 3743, "ml"],
  ["tt0000002", "Mal Thriller Few Votes", 2020, "Thriller", 8.5, 900, "ml"],
  ["tt0000003", "Mal Thriller Seven", 2019, "Crime,Thriller", 7.0, 5000, "ml"],
  ["tt0000004", "Mal Drama", 2018, "Drama", 8.0, 9000, "ml"],
  ["tt0000005", "Mal Thriller Recent", 2023, "Action,Thriller", 7.6, 20000, "ml"],
  ["tt0000006", "Tamil Thriller", 2019, "Thriller", 8.5, 40000, "ta"],
  ["tt0000007", "Parasite", 2019, "Drama,Thriller", 8.5, 1000000, "ko", "Gisaengchung"],
  ["tt0000008", "Korean Drama", 2016, "Drama", 7.8, 30000, "ko"],
  ["tt0000009", "Korean Low", 2016, "Drama", 6.9, 30000, "ko"],
  ["tt0000010", "Unknown Language Thriller", 2001, "Thriller", 8.0, 15000, null],
  ["tt0000011", "Some Musical", 1965, "Musical", 8.0, 15000, "en"],
  ["tt0000012", "The Godfather", 1972, "Crime,Drama", 9.2, 2000000, "en"],
  ["tt0000013", "The Godfather Part II", 1974, "Crime,Drama", 9.0, 1400000, "en"],
  ["tt0000014", "Parasite", 1982, "Horror,Sci-Fi", 7.1, 3000, "en"],
  ["tt0000016", "Godfather", 1991, "Comedy,Drama", 8.6, 4940, "ml"],
  ["tt0000017", "Quiet Harbour", 2024, "Drama", 7.2, 8000, "en"],
  ["tt0000015", "Amélie", 2001, "Comedy,Romance", 8.3, 800000, "fr", "Le fabuleux destin d'Amélie Poulain"],
];

type Series = [id: string, title: string, year: number, endYear: number | null, type: "tvSeries" | "tvMiniSeries", genres: string, rating: number, votes: number, lang: string | null];

const SERIES: Series[] = [
  ["tt0903747", "Breaking Bad", 2008, 2013, "tvSeries", "Crime,Drama,Thriller", 9.5, 2200000, "en"],
  ["tt0000101", "Mal Series", 2020, null, "tvSeries", "Crime,Thriller", 8.4, 20000, "ml"],
  ["tt0000102", "Mini Heist", 2021, 2021, "tvMiniSeries", "Crime,Thriller", 8.1, 30000, "es"],
  ["tt0000103", "Quiet Harbour", 2010, 2012, "tvSeries", "Drama", 7.5, 5000, "en"], // same title as a movie below
];

async function seed(db: Db) {
  const catalogue = new SqliteCatalogueRepository(db);
  await catalogue.beginStaging();
  await catalogue.insertStaging(
    MOVIES.map(([imdb_id, title, year, genres, rating, votes, , original]): MovieRow => ({
      imdb_id,
      title,
      original_title: original ?? null,
      year,
      runtime_min: 120,
      genres,
      rating,
      votes,
      title_type: "movie",
      end_year: null,
    })),
  );
  await catalogue.insertStaging(
    SERIES.map(([imdb_id, title, year, end_year, title_type, genres, rating, votes]): MovieRow => ({
      imdb_id,
      title,
      original_title: null,
      year,
      runtime_min: 45,
      genres,
      rating,
      votes,
      title_type,
      end_year,
    })),
  );
  await catalogue.swapStaging();
  const insert = db.prepare("INSERT INTO movie_language VALUES (?, ?, 'manual', '2026-01-01')");
  for (const [id, , , , , , lang] of MOVIES) if (lang) insert.run(id, lang);
  for (const [id, , , , , , , , lang] of SERIES) if (lang) insert.run(id, lang);
}

describe("MCP server", () => {
  let db: Db;
  let client: Client;

  before(async () => {
    db = openDatabase(":memory:");
    await seed(db);
    const server = createMcpServer(createShelfService(db));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  after(async () => {
    await client.close();
    db.close();
  });

  beforeEach(() => db.exec("DELETE FROM watched; DELETE FROM watchlist"));

  // biome-ignore lint: test helper
  async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) throw new Error((res.content as { text: string }[])[0]!.text);
    return res.structuredContent;
  }
  async function callError(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `expected ${name} to fail`);
    return (res.content as { text: string }[])[0]!.text;
  }
  const ids = (r: { movies: { imdb_id: string }[] }) => r.movies.map((m) => m.imdb_id);

  it("lists the eight tools with descriptions and schemas", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "add_to_watchlist",
      "list_watched",
      "list_watchlist",
      "mark_watched",
      "recommend",
      "remove_from_watchlist",
      "search_title",
      "unmark_watched",
    ]);
    for (const t of tools) {
      assert.ok((t.description ?? "").length > 80, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, "object");
    }
    const recommend = tools.find((t) => t.name === "recommend")!;
    assert.equal(recommend.annotations?.readOnlyHint, true);
  });

  describe("acceptance checks", () => {
    it('recommend({language: "Malayalam", genre: "Thriller"}): only Malayalam thrillers, rating > 7.0, votes >= 1000, unwatched', async () => {
      await call("mark_watched", { imdb_id: "tt0000005" });
      const r = await call("recommend", { language: "Malayalam", genre: "Thriller" });
      assert.deepEqual(ids(r), ["tt0000001", "tt3417422"]); // 8.9, 8.4
      assert.equal(r.total_matches, 2);
      for (const m of r.movies) {
        assert.equal(m.language_code, "ml");
        assert.ok(m.genres.includes("Thriller"));
        assert.ok(m.rating > 7.0);
        assert.ok(m.votes >= 1000);
      }
    });

    it("a movie marked watched never appears in recommend again", async () => {
      const before = await call("recommend", { limit: 25 });
      const first = before.movies[0].imdb_id;
      await call("mark_watched", { imdb_id: first });
      for (const sort of ["top", "shuffle"]) {
        const r = await call("recommend", { limit: 25, sort });
        assert.ok(!ids(r).includes(first), `${first} still recommended with sort=${sort}`);
        assert.equal(r.total_matches, before.total_matches - 1);
      }
    });

    it('mark_watched({title: "Drishyam"}) writes nothing and returns both candidates', async () => {
      const r = await call("mark_watched", { title: "Drishyam" });
      assert.equal(r.written, false);
      assert.equal(r.status, "ambiguous");
      const cands = r.candidates.map((c: { imdb_id: string; year: number; language_code: string }) => `${c.imdb_id}:${c.year}:${c.language_code}`);
      assert.ok(cands.includes("tt3417422:2013:ml"));
      assert.ok(cands.includes("tt4430212:2015:hi"));
      assert.equal(db.prepare("SELECT COUNT(*) FROM watched").pluck().get(), 0);
    });

    it('recommend({language: "ko"}) equals recommend({language: "Korean"})', async () => {
      const a = await call("recommend", { language: "ko" });
      const b = await call("recommend", { language: "Korean" });
      const c = await call("recommend", { language: "kor" });
      assert.deepEqual(a.movies, b.movies);
      assert.deepEqual(a.movies, c.movies);
      assert.deepEqual(ids(a), ["tt0000007", "tt0000008"]);
    });
  });

  describe("recommend", () => {
    it("defaults: rating > 7.0, votes >= 1000, top sort, limit 10", async () => {
      const r = await call("recommend");
      assert.equal(r.showing, 10);
      assert.ok(r.total_matches > 10);
      assert.deepEqual(r.filters, {
        language: null,
        genre: [],
        type: "movie",
        exclude_genres: [],
        keyword: [],
        mood: null,
        min_rating: 7,
        min_votes: 1000,
        year_from: null,
        year_to: null,
        sort: "top",
        excludes_watched: true,
      });
      const ratings = r.movies.map((m: { rating: number }) => m.rating);
      assert.deepEqual(ratings, [...ratings].sort((x, y) => y - x));
      assert.ok(r.movies.every((m: { rating: number }) => m.rating > 7));
    });

    it("includes movies without a language only when no language filter is given", async () => {
      assert.ok(ids(await call("recommend", { genre: "thriller", limit: 25 })).includes("tt0000010"));
      assert.ok(!ids(await call("recommend", { language: "en", genre: "thriller", limit: 25 })).includes("tt0000010"));
    });

    it("genre accepts a list: movies must have all the genres", async () => {
      const r = await call("recommend", { genre: ["Thriller", "crime"], limit: 25 });
      assert.deepEqual(r.filters.genre, ["Thriller", "Crime"]);
      assert.ok(r.movies.length > 0);
      for (const m of r.movies) assert.ok(m.genres.includes("Thriller") && m.genres.includes("Crime"));
      const single = await call("recommend", { genre: "Thriller", limit: 25 });
      assert.ok(single.total_matches > r.total_matches);
    });

    it("exclude_genres leaves out movies with any excluded genre (aliases accepted)", async () => {
      const all = await call("recommend", { limit: 25 });
      const r = await call("recommend", { exclude_genres: ["Thriller", "musicals"], limit: 25 });
      assert.deepEqual(r.filters.exclude_genres, ["Thriller", "Musical"]);
      assert.ok(r.total_matches < all.total_matches);
      for (const m of r.movies) {
        assert.ok(!m.genres.includes("Thriller") && !m.genres.includes("Musical"));
      }
      assert.ok(!ids(r).includes("tt0000011"));
      assert.match(await callError("recommend", { genre: "Thriller", exclude_genres: ["thriller"] }), /both contain/);
      assert.match(await callError("recommend", { exclude_genres: ["Cowboy"] }), /Unknown genre "Cowboy"/);
    });

    it("keyword and mood filters use imported TMDB keywords", async () => {
      const kw = db.prepare("INSERT INTO movie_keyword VALUES (?, ?)");
      kw.run("tt0000001", "heist");
      kw.run("tt0000001", "time travel");
      kw.run("tt0000004", "heist gone wrong");
      kw.run("tt0000011", "heartwarming"); // Musical
      kw.run("tt0000014", "friendship"); // Horror/Sci-Fi: contradicts feel-good
      kw.run("tt0000008", "100%_odd");

      const heist = await call("recommend", { keyword: "HEIST", limit: 25 });
      assert.deepEqual(ids(heist), ["tt0000001", "tt0000004"]); // substring, case-insensitive
      assert.deepEqual(heist.filters.keyword, ["heist"]);

      assert.deepEqual(ids(await call("recommend", { keyword: ["heist", "time travel"] })), ["tt0000001"]); // ALL
      assert.deepEqual(ids(await call("recommend", { keyword: "heist", language: "ml", genre: "Drama" })), ["tt0000004"]);
      // LIKE wildcards are literal: "%" matches only the keyword containing a percent sign, "100_odd" none.
      assert.deepEqual(ids(await call("recommend", { keyword: "%" })), ["tt0000008"]);
      assert.deepEqual(ids(await call("recommend", { keyword: "100_odd" })), []);
      assert.deepEqual(ids(await call("recommend", { keyword: "100%_odd" })), ["tt0000008"]);

      const mood = await call("recommend", { mood: "Feel good", limit: 25 });
      assert.deepEqual(ids(mood), ["tt0000011"]); // tt0000014 is Horror: excluded by the mood
      assert.equal(mood.filters.mood, "feel-good");
      assert.deepEqual(mood.filters.exclude_genres, ["Horror", "War"]);
      // Asking for the genre explicitly overrides the mood's exclusion.
      assert.deepEqual(ids(await call("recommend", { mood: "feel-good", genre: "Horror", min_votes: 1000 })), ["tt0000014"]);

      assert.match(await callError("recommend", { mood: "grumpy" }), /Unknown mood "grumpy"\. Valid moods: feel-good/);
      assert.match(await callError("recommend", { keyword: "  " }), /must not be empty/);
    });

    it("recommends movies by default; type switches to series or both", async () => {
      const movies = await call("recommend", { limit: 25 });
      assert.ok(movies.movies.every((m: { type: string }) => m.type === "movie"));
      assert.equal(movies.filters.type, "movie");
      assert.ok(!ids(movies).includes("tt0903747"));

      const series = await call("recommend", { type: "series", limit: 25 });
      assert.deepEqual(ids(series), ["tt0903747", "tt0000101", "tt0000102", "tt0000103"]);
      const byId = Object.fromEntries(series.movies.map((m: { imdb_id: string }) => [m.imdb_id, m]));
      assert.deepEqual(
        [byId.tt0903747.type, byId.tt0903747.end_year, byId.tt0000101.end_year, byId.tt0000102.type],
        ["series", 2013, null, "miniseries"], // end_year null = still running
      );
      assert.equal("end_year" in movies.movies[0], false);

      const any = await call("recommend", { type: "any", limit: 25 });
      assert.equal(any.total_matches, movies.total_matches + series.total_matches);

      assert.deepEqual(ids(await call("recommend", { type: "series", language: "ml", genre: "Thriller" })), ["tt0000101"]);
      assert.deepEqual(ids(await call("recommend", { type: "series", language: "es" })), ["tt0000102"]);
      assert.match(await callError("recommend", { type: "anime" }), /Input validation|type must be one of/);
    });

    it("series can be watched and watchlisted; lists filter by type", async () => {
      await call("mark_watched", { imdb_id: "tt0903747", my_rating: 10 });
      assert.ok(!ids(await call("recommend", { type: "series", limit: 25 })).includes("tt0903747"));
      await call("add_to_watchlist", { imdb_id: "tt0000101" });
      await call("add_to_watchlist", { imdb_id: "tt0000001" });

      const watched = await call("list_watched", {});
      assert.equal(watched.entries[0].type, "series");
      const wl = await call("list_watchlist", { type: "series" });
      assert.deepEqual(wl.entries.map((e: { imdb_id: string }) => e.imdb_id), ["tt0000101"]);
      assert.equal((await call("list_watchlist", { type: "movie" })).entries[0].imdb_id, "tt0000001");
      assert.equal((await call("list_watchlist", {})).total, 2);
    });

    it("search_title finds series and labels the type, so same-title movies need disambiguation", async () => {
      const r = await call("search_title", { query: "Breaking Bad" });
      assert.equal(r.results[0].type, "series");
      const w = await call("mark_watched", { title: "Quiet Harbour" });
      assert.equal(w.written, false); // movie "Quiet Harbour" (2024) vs series "Quiet Harbour" (2010)
      assert.deepEqual(w.candidates.map((c: { type: string }) => c.type).sort(), ["movie", "series"]);
    });

    it("matches whole genres only and accepts genre aliases", async () => {
      assert.deepEqual(ids(await call("recommend", { genre: "Music" })), []);
      assert.deepEqual(ids(await call("recommend", { genre: "musicals" })), ["tt0000011"]);
      assert.deepEqual(ids(await call("recommend", { genre: "science fiction", min_votes: 1000 })), ["tt0000014"]);
    });

    it("filters by year range and returns the IMDb URL", async () => {
      const r = await call("recommend", { year_from: 2019, year_to: 2019 });
      assert.ok(r.movies.every((m: { year: number }) => m.year === 2019));
      assert.equal(r.movies[0].imdb_url, `https://www.imdb.com/title/${r.movies[0].imdb_id}/`);
    });

    it("shuffle returns a random sample of the same match set", async () => {
      const all = new Set(ids(await call("recommend", { limit: 25 })));
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const r = await call("recommend", { sort: "shuffle", limit: 3 });
        assert.equal(r.showing, 3);
        for (const id of ids(r)) {
          assert.ok(all.has(id));
          seen.add(id);
        }
      }
      assert.ok(seen.size > 3, "shuffle should vary between calls");
    });

    it("rejects bad parameters with a readable error", async () => {
      assert.match(await callError("recommend", { language: "Klingon" }), /Unknown language "Klingon"/);
      assert.match(await callError("recommend", { genre: "Cowboy" }), /Unknown genre "Cowboy".*Thriller/);
      assert.match(await callError("recommend", { min_rating: 6 }), /7/);
      assert.match(await callError("recommend", { limit: 26 }), /25/);
      assert.match(await callError("recommend", { year_from: 2020, year_to: 2010 }), /year_from/);
    });
  });

  describe("search_title", () => {
    it("finds by title, ignoring case, accents and a leading article", async () => {
      const r = await call("search_title", { query: "amelie" });
      assert.equal(r.results[0].imdb_id, "tt0000015");
      const g = await call("search_title", { query: "godfather" });
      assert.deepEqual(g.results.map((x: { imdb_id: string }) => x.imdb_id), ["tt0000012", "tt0000016", "tt0000013"]);
      assert.equal(g.results[0].match, "exact");
    });

    it("finds by original title and reports watched status", async () => {
      await call("mark_watched", { imdb_id: "tt0000007" });
      const r = await call("search_title", { query: "Gisaengchung" });
      assert.equal(r.results[0].imdb_id, "tt0000007");
      assert.equal(r.results[0].watched, true);
      assert.equal(r.results[0].language, "Korean");
    });

    it("narrows by year, tolerating an off-by-one year", async () => {
      assert.deepEqual((await call("search_title", { query: "Drishyam", year: 2015 })).results.map((x: { imdb_id: string }) => x.imdb_id), ["tt4430212"]);
      assert.deepEqual((await call("search_title", { query: "Drishyam", year: 2014 })).results.length, 2);
    });

    it("accepts an IMDb URL", async () => {
      const r = await call("search_title", { query: "https://www.imdb.com/title/tt3417422/?ref_=x" });
      assert.equal(r.results[0].title, "Drishyam");
    });
  });

  describe("mark_watched / unmark_watched", () => {
    it("writes a single exact title match", async () => {
      const r = await call("mark_watched", { title: "The Godfather", watched_on: "2026-10-01", my_rating: 9 });
      assert.equal(r.written, true);
      assert.equal(r.imdb_id, "tt0000012");
    });

    it('prefers the literal title: "The Godfather" is not "Godfather"', async () => {
      assert.equal((await call("mark_watched", { title: "The Godfather" })).imdb_id, "tt0000012");
      const bare = await call("mark_watched", { title: "Godfather" });
      assert.equal(bare.written, false);
      assert.equal(bare.status, "ambiguous");
    });

    it('finds "Godfather 2" via Roman numerals, but only as a suggestion', async () => {
      const r = await call("mark_watched", { title: "Godfather 2" });
      assert.equal(r.written, false);
      assert.equal(r.candidates[0].imdb_id, "tt0000013");
    });

    it("disambiguates with a year", async () => {
      const r = await call("mark_watched", { title: "drishyam", year: 2013 });
      assert.equal(r.written, true);
      assert.equal(r.imdb_id, "tt3417422");
    });

    it("does not write a partial match", async () => {
      const r = await call("mark_watched", { title: "Godfather Part" });
      assert.equal(r.written, false);
      assert.equal(r.status, "needs_confirmation");
      assert.equal(r.candidates[0].imdb_id, "tt0000013");
      const nf = await call("mark_watched", { title: "Nonexistent Movie Xyz" });
      assert.equal(nf.status, "not_found");
      assert.equal(db.prepare("SELECT COUNT(*) FROM watched").pluck().get(), 0);
    });

    it("is idempotent and only overwrites fields that are given", async () => {
      const a = await call("mark_watched", { imdb_id: "tt0000012", my_rating: 9, notes: "classic" });
      assert.equal(a.created, true);
      const b = await call("mark_watched", { imdb_id: "tt0000012", watched_on: "2026-10-02" });
      assert.equal(b.created, false);
      const row = db.prepare("SELECT * FROM watched").all() as Record<string, unknown>[];
      assert.equal(row.length, 1);
      assert.equal(row[0]!.my_rating, 9);
      assert.equal(row[0]!.notes, "classic");
      assert.equal(row[0]!.watched_on, "2026-10-02");
      assert.equal(row[0]!.added_via, "mcp");
    });

    it("saves an ID that is not in the catalogue", async () => {
      const r = await call("mark_watched", { imdb_id: "tt9999999" });
      assert.equal(r.written, true);
      assert.equal(r.movie, null);
      assert.match(r.note, /Not in the local catalogue/);
    });

    it("validates input", async () => {
      assert.match(await callError("mark_watched", {}), /imdb_id or title/);
      assert.match(await callError("mark_watched", { imdb_id: "12345" }), /not an IMDb title ID/);
      assert.match(await callError("mark_watched", { imdb_id: "tt0000012", watched_on: "2026-02-30" }), /YYYY-MM-DD/);
      assert.match(await callError("mark_watched", { imdb_id: "tt0000012", my_rating: 11 }), /10/);
    });

    it("unmark removes it so it can be recommended again", async () => {
      await call("mark_watched", { imdb_id: "tt0000012" });
      assert.ok(!ids(await call("recommend")).includes("tt0000012"));
      const r = await call("unmark_watched", { imdb_id: "tt0000012" });
      assert.equal(r.removed, true);
      assert.equal(r.title, "The Godfather");
      assert.ok(ids(await call("recommend")).includes("tt0000012"));
      assert.equal((await call("unmark_watched", { imdb_id: "tt0000012" })).removed, false);
    });
  });

  describe("list_watched", () => {
    beforeEach(async () => {
      await call("mark_watched", { imdb_id: "tt3417422", watched_on: "2024-05-01" });
      await call("mark_watched", { imdb_id: "tt0000007", watched_on: "2026-01-15", my_rating: 10 });
      await call("mark_watched", { imdb_id: "tt0000012", watched_on: "2025-03-01" });
      await call("mark_watched", { imdb_id: "tt9999999" }); // not in catalogue, no date: added today
    });

    it("lists newest first, including entries missing from the catalogue", async () => {
      const r = await call("list_watched");
      assert.equal(r.total, 4);
      assert.deepEqual(r.entries.map((e: { imdb_id: string }) => e.imdb_id), ["tt9999999", "tt0000007", "tt0000012", "tt3417422"]);
      const missing = r.entries[0];
      assert.equal(missing.title, null);
      assert.equal(missing.in_catalogue, false);
      assert.equal(missing.imdb_url, "https://www.imdb.com/title/tt9999999/");
    });

    it("filters by language, genre and title, and pages", async () => {
      assert.deepEqual((await call("list_watched", { language: "Korean" })).entries.map((e: { imdb_id: string }) => e.imdb_id), ["tt0000007"]);
      assert.deepEqual((await call("list_watched", { genre: "crime" })).entries.map((e: { imdb_id: string }) => e.imdb_id), ["tt0000012", "tt3417422"]);
      assert.deepEqual((await call("list_watched", { query: "godfather" })).entries.map((e: { imdb_id: string }) => e.imdb_id), ["tt0000012"]);
      const page = await call("list_watched", { limit: 2, offset: 2 });
      assert.equal(page.total, 4);
      assert.deepEqual(page.entries.map((e: { imdb_id: string }) => e.imdb_id), ["tt0000012", "tt3417422"]);
    });
  });

  describe("watchlist", () => {
    const listIds = (r: { entries: { imdb_id: string }[] }) => r.entries.map((e) => e.imdb_id);

    it("adds by imdb_id with notes, idempotently", async () => {
      const a = await call("add_to_watchlist", { imdb_id: "tt0000006", notes: "recommended by Arun" });
      assert.equal(a.status, "added");
      assert.equal(a.created, true);
      assert.equal(a.movie.on_watchlist, true);
      const b = await call("add_to_watchlist", { imdb_id: "tt0000006" });
      assert.equal(b.created, false);
      const list = await call("list_watchlist");
      assert.equal(list.total, 1);
      assert.equal(list.entries[0].notes, "recommended by Arun"); // kept when re-adding without notes
      assert.equal(list.entries[0].title, "Tamil Thriller");
    });

    it("applies the same title rules as mark_watched", async () => {
      const amb = await call("add_to_watchlist", { title: "Drishyam" });
      assert.equal(amb.written, false);
      assert.equal(amb.status, "ambiguous");
      assert.match(amb.message, /call add_to_watchlist again/);
      const ok = await call("add_to_watchlist", { title: "Drishyam", year: 2015 });
      assert.equal(ok.imdb_id, "tt4430212");
      assert.equal((await call("list_watchlist")).total, 1);
    });

    it("refuses movies already watched", async () => {
      await call("mark_watched", { imdb_id: "tt0000012", watched_on: "2025-03-01" });
      const r = await call("add_to_watchlist", { imdb_id: "tt0000012" });
      assert.equal(r.status, "already_watched");
      assert.equal(r.written, false);
      assert.match(r.message, /2025-03-01/);
      assert.equal((await call("list_watchlist")).total, 0);
    });

    it("mark_watched removes the movie from the watchlist", async () => {
      await call("add_to_watchlist", { imdb_id: "tt0000007" });
      const r = await call("mark_watched", { imdb_id: "tt0000007" });
      assert.equal(r.removed_from_watchlist, true);
      assert.equal((await call("list_watchlist")).total, 0);
      const again = await call("mark_watched", { imdb_id: "tt0000007" });
      assert.equal(again.removed_from_watchlist, false);
    });

    it("flags watchlisted movies in recommend and search_title", async () => {
      await call("add_to_watchlist", { imdb_id: "tt0000001" });
      const rec = await call("recommend", { language: "ml", genre: "Thriller" });
      const flags = Object.fromEntries(rec.movies.map((m: { imdb_id: string; on_watchlist: boolean }) => [m.imdb_id, m.on_watchlist]));
      assert.deepEqual(flags, { tt0000001: true, tt3417422: false, tt0000005: false });
      const s = await call("search_title", { query: "Mal Thriller Top" });
      assert.equal(s.results[0].on_watchlist, true);
    });

    it("lists newest first or by rating, with filters, including titles outside the catalogue", async () => {
      await call("add_to_watchlist", { imdb_id: "tt0000008" }); // Korean Drama 7.8
      await call("add_to_watchlist", { imdb_id: "tt9999998" }); // not in catalogue
      await call("add_to_watchlist", { imdb_id: "tt0000007" }); // Parasite 8.5, ko
      await call("add_to_watchlist", { imdb_id: "tt0000011" }); // Some Musical 8.0, en
      assert.deepEqual(listIds(await call("list_watchlist")), ["tt0000011", "tt0000007", "tt9999998", "tt0000008"]);
      assert.deepEqual(listIds(await call("list_watchlist", { sort: "rating" })), ["tt0000007", "tt0000011", "tt0000008", "tt9999998"]);
      assert.deepEqual(listIds(await call("list_watchlist", { language: "Korean", sort: "rating" })), ["tt0000007", "tt0000008"]);
      assert.deepEqual(listIds(await call("list_watchlist", { genre: "musical" })), ["tt0000011"]);
      assert.deepEqual(listIds(await call("list_watchlist", { query: "parasite" })), ["tt0000007"]);
      const missing = (await call("list_watchlist", { query: "tt9999998" })).entries[0];
      assert.equal(missing.in_catalogue, false);
      assert.equal(missing.title, null);
    });

    it("remove_from_watchlist removes without marking watched", async () => {
      await call("add_to_watchlist", { imdb_id: "tt0000012" });
      const r = await call("remove_from_watchlist", { imdb_id: "tt0000012" });
      assert.equal(r.removed, true);
      assert.equal(r.title, "The Godfather");
      assert.equal((await call("list_watchlist")).total, 0);
      assert.equal((await call("list_watched")).total, 0);
      assert.equal((await call("remove_from_watchlist", { imdb_id: "tt0000012" })).removed, false);
    });
  });
});
