import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MovieRow } from "../src/db/repository.js";
import type { Db } from "../src/db/sqlite.js";
import { openDatabase } from "../src/db/sqlite.js";
import {
  SqliteCatalogueRepository,
  SqliteImportRunRepository,
  SqliteLanguageRepository,
} from "../src/db/sqlite-repository.js";
import { languageName, normaliseLanguage } from "../src/languages/normalise.js";
import { TmdbAuthError, TmdbClient, importTmdbLanguages } from "../src/languages/tmdb.js";
import { importWikidataLanguages } from "../src/languages/wikidata.js";

describe("normaliseLanguage", () => {
  const cases: [string, string | null][] = [
    ["ml", "ml"],
    ["Malayalam", "ml"],
    ["MALAYALAM", "ml"],
    [" malayalam ", "ml"],
    ["mal", "ml"],
    ["ko", "ko"],
    ["Korean", "ko"],
    ["kor", "ko"],
    ["Hindi", "hi"],
    ["Tamil", "ta"],
    ["Telugu", "te"],
    ["Kannada", "kn"],
    ["Marathi", "mr"],
    ["Bengali", "bn"],
    ["Bangla", "bn"],
    ["Odia", "or"],
    ["Oriya", "or"],
    ["Punjabi", "pa"],
    ["Japanese", "ja"],
    ["Mandarin", "zh"],
    ["Chinese", "zh"],
    ["Cantonese", "cn"],
    ["Spanish", "es"],
    ["Français", null], // English names only
    ["French", "fr"],
    ["Persian", "fa"],
    ["Farsi", "fa"],
    ["Klingon", null],
    ["", null],
    ["xx", null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => assert.equal(normaliseLanguage(input), expected));
  }

  it("names codes in English", () => {
    assert.equal(languageName("ml"), "Malayalam");
    assert.equal(languageName("bn"), "Bengali");
    assert.equal(languageName("cn"), "Cantonese");
  });
});

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

/** Fake `fetch` returning a SPARQL TSV body. */
function wikidataFetch(rows: [string, string][], status = 200): typeof fetch {
  return (async () => {
    const body = ["?imdb\t?code", ...rows.map(([i, c]) => `"${i}"\t"${c}"`)].join("\n") + "\n";
    return new Response(status === 200 ? body : "timeout", { status });
  }) as typeof fetch;
}

describe("language enrichment", () => {
  let db: Db;
  let languages: SqliteLanguageRepository;
  let runs: SqliteImportRunRepository;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    languages = new SqliteLanguageRepository(db);
    runs = new SqliteImportRunRepository(db);
    const catalogue = new SqliteCatalogueRepository(db);
    await catalogue.beginStaging();
    await catalogue.insertStaging([
      movie("tt3417422", 8.4, 50000), // Drishyam (ml)
      movie("tt4430212", 8.2, 110000), // Drishyam (hi)
      movie("tt0000001", 7.5, 5000), // multi-language on Wikidata
      movie("tt0000002", 8.0, 2000), // missing from Wikidata
      movie("tt0000003", 6.0, 9000), // below rating filter
      movie("tt0000004", 7.0, 9000), // exactly 7.0: not > 7.0
      movie("tt0000005", 9.0, 999), // below vote filter
    ]);
    await catalogue.swapStaging();
  });

  afterEach(() => db.close());

  const lang = (id: string) =>
    db.prepare("SELECT lang, source FROM movie_language WHERE imdb_id = ?").get(id) as
      | { lang: string; source: string }
      | undefined;

  const wikidata = (rows: [string, string][], extra: { force?: boolean; status?: number } = {}) =>
    importWikidataLanguages({
      languages,
      runs,
      client: { endpoint: "http://wdqs.test/sparql", userAgent: "test", fetch: wikidataFetch(rows, extra.status) },
      ...(extra.force !== undefined ? { force: extra.force } : {}),
    });

  it("stores single-language Wikidata rows and skips multi-language ones", async () => {
    const r = await wikidata([
      ["tt3417422", "ml"],
      ["tt4430212", "hi"],
      ["tt4430212", "hi"], // duplicate item, same language
      ["tt0000001", "hi"],
      ["tt0000001", "en"],
      ["tt9999999", "ko"], // not in catalogue: still stored
      ["nm0000001", "en"], // not a title ID
      ["tt0000006", "zz"], // unknown code
    ]);
    assert.equal(r.resolved, 3);
    assert.equal(r.ambiguous, 1);
    assert.deepEqual(lang("tt3417422"), { lang: "ml", source: "wikidata" });
    assert.deepEqual(lang("tt4430212"), { lang: "hi", source: "wikidata" });
    assert.equal(lang("tt0000001"), undefined);
    assert.deepEqual(lang("tt9999999"), { lang: "ko", source: "wikidata" });
    assert.equal((await runs.latestRuns("wikidata", 1))[0]?.status, "success");
  });

  it("never overwrites manual languages and removes stale Wikidata rows", async () => {
    db.prepare(
      "INSERT INTO movie_language VALUES ('tt3417422', 'ta', 'manual', '2020-01-01T00:00:00.000Z')",
    ).run();
    await wikidata([["tt3417422", "ml"], ["tt4430212", "hi"], ["tt0000002", "fr"]]);
    assert.deepEqual(lang("tt3417422"), { lang: "ta", source: "manual" });

    // tt0000002 disappears from Wikidata (e.g. corrected to multi-language).
    await wikidata([["tt3417422", "ml"], ["tt4430212", "hi"], ["tt0000002", "fr"], ["tt0000002", "en"]]);
    assert.equal(lang("tt0000002"), undefined);
    assert.deepEqual(lang("tt4430212"), { lang: "hi", source: "wikidata" });
  });

  it("writes nothing when the Wikidata query fails", async () => {
    await wikidata([["tt3417422", "ml"]]);
    const noSleepFetch = wikidataFetch([], 500);
    await assert.rejects(
      importWikidataLanguages({
        languages,
        runs,
        client: {
          endpoint: "http://wdqs.test/sparql",
          userAgent: "test",
          fetch: noSleepFetch,
          retryDelayMs: 0,
        },
      }),
    );
    assert.deepEqual(lang("tt3417422"), { lang: "ml", source: "wikidata" });
    assert.equal((await runs.latestRuns("wikidata", 1))[0]?.status, "failed");
  });

  it("refuses a Wikidata result that lost more than half the rows unless forced", async () => {
    await wikidata([["tt3417422", "ml"], ["tt4430212", "hi"], ["tt0000002", "fr"]]);
    await assert.rejects(wikidata([["tt3417422", "ml"]]), /refusing to apply/);
    assert.equal(await languages.countBySource("wikidata"), 3);
    await wikidata([["tt3417422", "ml"]], { force: true });
    assert.equal(await languages.countBySource("wikidata"), 1);
  });

  it("TMDB fallback only queries unresolved movies passing the default filter", async () => {
    await wikidata([["tt3417422", "ml"], ["tt4430212", "hi"]]);
    const asked: string[] = [];
    const client = {
      async findOriginalLanguage(id: string) {
        asked.push(id);
        return id === "tt0000001" ? { status: "found" as const, lang: "hi" } : { status: "not_found" as const };
      },
    };
    const opts = { languages, runs, client, minRating: 7.0, minVotes: 1000 };

    const r = await importTmdbLanguages(opts);
    // Most-voted first; tt0000003/4/5 fail the filter; Drishyams already resolved.
    assert.deepEqual(asked, ["tt0000001", "tt0000002"]);
    assert.equal(r.found, 1);
    assert.deepEqual(lang("tt0000001"), { lang: "hi", source: "tmdb" });

    // Second run: the found one is resolved, the miss is not retried yet.
    asked.length = 0;
    await importTmdbLanguages(opts);
    assert.deepEqual(asked, []);

    // After the retry window, the miss is queried again.
    await importTmdbLanguages({ ...opts, now: () => new Date(Date.now() + 31 * 86_400_000) });
    assert.deepEqual(asked, ["tt0000002"]);
  });

  it("Wikidata later replaces a TMDB language", async () => {
    await languages.recordTmdbLookup("tt0000002", "found", "fr", new Date().toISOString());
    await wikidata([["tt0000002", "it"]]);
    assert.deepEqual(lang("tt0000002"), { lang: "it", source: "wikidata" });
  });
});

describe("TmdbClient", () => {
  const noSleep = async () => {};
  const client = (handler: (url: URL, init?: RequestInit) => Response, apiKey = "abc123") =>
    new TmdbClient({
      apiKey,
      userAgent: "test",
      baseUrl: "http://tmdb.test/3",
      sleep: noSleep,
      requestsPerSecond: 1e9,
      fetch: (async (url: URL, init?: RequestInit) => handler(new URL(url), init)) as typeof fetch,
    });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it("reads movie_results[0].original_language with a v3 key", async () => {
    let seen: URL | undefined;
    const c = client((url) => {
      seen = url;
      return json({ movie_results: [{ original_language: "ml" }], tv_results: [] });
    });
    assert.deepEqual(await c.findOriginalLanguage("tt3417422"), { status: "found", lang: "ml" });
    assert.equal(seen?.pathname, "/3/find/tt3417422");
    assert.equal(seen?.searchParams.get("external_source"), "imdb_id");
    assert.equal(seen?.searchParams.get("api_key"), "abc123");
  });

  it("uses a bearer header for v4 tokens", async () => {
    let auth: string | null = null;
    let seen: URL | undefined;
    const c = client((url, init) => {
      seen = url;
      auth = new Headers(init?.headers).get("authorization");
      return json({ movie_results: [{ original_language: "ko" }] });
    }, "eyJhbGciOi.token");
    await c.findOriginalLanguage("tt1");
    assert.equal(auth, "Bearer eyJhbGciOi.token");
    assert.equal(seen?.searchParams.has("api_key"), false);
  });

  it("maps empty results and 'xx' to misses", async () => {
    assert.deepEqual(await client(() => json({ movie_results: [] })).findOriginalLanguage("tt1"), {
      status: "not_found",
    });
    assert.deepEqual(
      await client(() => json({ movie_results: [{ original_language: "xx" }] })).findOriginalLanguage("tt1"),
      { status: "no_language" },
    );
  });

  it("retries on 429 and 5xx", async () => {
    const responses = [
      json({}, 429, { "retry-after": "1" }),
      json({}, 503),
      json({ movie_results: [{ original_language: "ta" }] }),
    ];
    const c = client(() => responses.shift()!);
    assert.deepEqual(await c.findOriginalLanguage("tt1"), { status: "found", lang: "ta" });
    assert.equal(responses.length, 0);
  });

  it("fails fast on a bad key", async () => {
    await assert.rejects(client(() => json({}, 401)).findOriginalLanguage("tt1"), TmdbAuthError);
  });
});
