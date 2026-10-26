import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normaliseTitle, parseImdbId } from "../src/lib/text.js";
import { normaliseGenre } from "../src/shelf/genres.js";
import { parseCsv, parseTitleList, planImdbRatingsCsv } from "../src/watched/parse.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas/newlines, CRLF and BOM", () => {
    const csv = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"multi\nline",\n';
    assert.deepEqual(parseCsv(csv), [
      ["a", "b", "c"],
      ["1", "x, y", 'say "hi"'],
      ["2", "multi\nline", ""],
    ]);
  });
});

describe("planImdbRatingsCsv", () => {
  const header =
    "Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors";
  const csv = [
    header,
    'tt3417422,9,2024-05-01,Drishyam,Drishyam,https://www.imdb.com/title/tt3417422/,Movie,8.4,160,2013,"Crime, Drama, Thriller",50000,2013-12-19,Jeethu Joseph',
    "tt0903747,10,2023-01-02,Breaking Bad,Breaking Bad,https://www.imdb.com/title/tt0903747/,TV Series,9.5,49,2008,Drama,2200000,2008-01-20,",
    "tt0959621,9,2023-01-03,Ozymandias,Ozymandias,https://www.imdb.com/title/tt0959621/,TV Episode,10,47,2013,Drama,200000,2013-09-15,",
    'tt0000012,8,2022-07-15,"Godfather, The",x,y,movie,9.2,175,1972,Crime,2000000,1972-03-24,"Coppola, F."',
  ].join("\n");

  it("imports movies and series, skipping episodes, using Const, Your Rating, Date Rated and Year", () => {
    const plan = planImdbRatingsCsv(csv);
    assert.deepEqual(plan.entries, [
      { imdb_id: "tt3417422", year: 2013, watched_on: "2024-05-01", my_rating: 9, added_via: "import" },
      { imdb_id: "tt0903747", year: 2008, watched_on: "2023-01-02", my_rating: 10, added_via: "import" },
      { imdb_id: "tt0000012", year: 1972, watched_on: "2022-07-15", my_rating: 8, added_via: "import" },
    ]);
    assert.equal(plan.skipped.length, 1);
    assert.match(plan.skipped[0]!.reason, /TV Episode/);
  });

  it("rejects files that are not an IMDb export", () => {
    assert.throws(() => planImdbRatingsCsv("Title,Year\nX,2000\n"), /missing "Const"/);
  });
});

describe("parseTitleList", () => {
  it("parses optional years in common formats", () => {
    const list = parseTitleList(
      ["# my list", "Drishyam (2013)", "Drishyam, 2015", "Apollo 13 1995", "Blade Runner 2049", "1917", "  ", "Kumbalangi Nights", "Drishyam 2 [2021]"].join("\n"),
    );
    assert.deepEqual(
      list.map(({ title, year }) => (year ? `${title}|${year}` : title)),
      ["Drishyam|2013", "Drishyam|2015", "Apollo 13|1995", "Blade Runner 2049", "1917", "Kumbalangi Nights", "Drishyam 2|2021"],
    );
    assert.equal(list[0]!.line, 2);
  });
});

describe("normalisers", () => {
  it("normaliseTitle", () => {
    assert.equal(normaliseTitle("The Godfather"), "godfather");
    assert.equal(normaliseTitle("Amélie"), "amelie");
    assert.equal(normaliseTitle("Schindler's List"), "schindlers list");
    assert.equal(normaliseTitle("Fast & Furious"), "fast and furious");
    assert.equal(normaliseTitle("Se7en"), "se7en");
    assert.equal(normaliseTitle("The"), "the");
    assert.equal(normaliseTitle("A Beautiful Mind"), "beautiful mind");
    assert.equal(normaliseTitle("The Godfather Part II"), "godfather part 2");
    assert.equal(normaliseTitle("Rocky IV"), "rocky 4");
    assert.equal(normaliseTitle("Malcolm X"), "malcolm x");
    assert.equal(normaliseTitle("दृश्यम"), "दृश्यम");
    assert.equal(normaliseTitle("ദൃശ്യം"), "ദൃശ്യം");
    // Same key whichever Unicode normal form the input arrives in.
    assert.equal(normaliseTitle("기생충".normalize("NFC")), normaliseTitle("기생충".normalize("NFD")));
    assert.equal(normaliseTitle("Ame\u0301lie"), "amelie");
  });

  it("parseImdbId", () => {
    assert.equal(parseImdbId("tt0111161"), "tt0111161");
    assert.equal(parseImdbId("https://www.imdb.com/title/tt0111161/?ref_=fn"), "tt0111161");
    assert.equal(parseImdbId("https://m.imdb.com/title/tt10872600"), "tt10872600");
    assert.equal(parseImdbId("tt123"), null);
    assert.equal(parseImdbId("Drishyam"), null);
  });

  it("normaliseGenre", () => {
    assert.equal(normaliseGenre("thriller"), "Thriller");
    assert.equal(normaliseGenre("Thrillers"), "Thriller");
    assert.equal(normaliseGenre("sci fi"), "Sci-Fi");
    assert.equal(normaliseGenre("Science Fiction"), "Sci-Fi");
    assert.equal(normaliseGenre("film noir"), "Film-Noir");
    assert.equal(normaliseGenre("Musical"), "Musical");
    assert.equal(normaliseGenre("Music"), "Music");
    assert.equal(normaliseGenre("cowboy"), null);
  });
});
