import { CATALOGUE_MIN_VOTES } from "../config.js";
import type {
  CatalogueRepository,
  ImportRunRepository,
  MovieRow,
  TitleType,
} from "../db/repository.js";
import {
  IMDB_FILES,
  nullable,
  nullableInt,
  readImdbTsv,
  type SourceOpener,
  type TsvStats,
} from "./tsv.js";

const RATINGS_COLUMNS = ["tconst", "averageRating", "numVotes"] as const;
const BASICS_COLUMNS = [
  "tconst",
  "titleType",
  "primaryTitle",
  "originalTitle",
  "isAdult",
  "startYear",
  "endYear",
  "runtimeMinutes",
  "genres",
] as const;

const CATALOGUE_TYPES: readonly string[] = ["movie", "tvSeries", "tvMiniSeries"] satisfies TitleType[];
const isCatalogueType = (t: string | undefined): t is TitleType => t !== undefined && CATALOGUE_TYPES.includes(t);

const BATCH_SIZE = 5_000;
/** Refuse to swap if the new catalogue shrinks below this share of the old one. */
const MIN_RETAINED_FRACTION = 0.5;

export interface ImdbImportOptions {
  catalogue: CatalogueRepository;
  runs: ImportRunRepository;
  source: SourceOpener;
  minVotes?: number;
  /** Skip the shrink guard (e.g. after deliberately raising the vote floor). */
  force?: boolean;
  log?: (msg: string) => void;
  /** Called with the import_runs id as soon as the run is recorded. */
  onRunStarted?: (runId: number) => void;
}

export interface ImdbImportResult {
  runId: number;
  rows: number;
  previousRows: number;
  ratingsLines: number;
  basicsLines: number;
  malformedLines: number;
}

/**
 * Downloads and imports the IMDb catalogue into a staging table, then swaps it
 * in atomically. Any failure discards the staging table and leaves the
 * previous catalogue untouched.
 */
export async function importImdb(opts: ImdbImportOptions): Promise<ImdbImportResult> {
  const { catalogue, runs, source } = opts;
  const minVotes = opts.minVotes ?? CATALOGUE_MIN_VOTES;
  const log = opts.log ?? (() => {});

  const runId = await runs.startRun("imdb");
  opts.onRunStarted?.(runId);
  try {
    // 1. Ratings (small file): keep only titles above the vote floor. Packed
    //    into one number per title to keep the map compact.
    log(`Reading ${IMDB_FILES.ratings} ...`);
    const ratingsStats: TsvStats = { lines: 0, malformed: 0 };
    const ratings = new Map<string, number>();
    for await (const [tconst, avg, votes] of readImdbTsv(
      await source(IMDB_FILES.ratings),
      RATINGS_COLUMNS,
      ratingsStats,
    )) {
      const v = Number.parseInt(votes!, 10);
      const r = Math.round(Number.parseFloat(avg!) * 10);
      if (v >= minVotes && Number.isFinite(r)) ratings.set(tconst!, packRating(r, v));
    }
    log(`  ${ratingsStats.lines.toLocaleString()} lines, ${ratings.size.toLocaleString()} titles with >= ${minVotes} votes`);
    if (ratings.size === 0) throw new Error("Ratings file produced no usable rows");

    // 2. Basics (large file): stream, filter, and batch-insert into staging.
    log(`Reading ${IMDB_FILES.basics} ...`);
    await catalogue.beginStaging();
    const basicsStats: TsvStats = { lines: 0, malformed: 0 };
    let batch: MovieRow[] = [];
    let kept = 0;
    for await (const f of readImdbTsv(await source(IMDB_FILES.basics), BASICS_COLUMNS, basicsStats)) {
      if (basicsStats.lines % 2_000_000 === 0) {
        log(`  ${basicsStats.lines.toLocaleString()} lines read, ${(kept + batch.length).toLocaleString()} movies kept`);
      }
      const [tconst, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear, runtime, genres] = f;
      if (!isCatalogueType(titleType) || isAdult !== "0") continue;
      const packed = ratings.get(tconst!);
      if (packed === undefined) continue;
      const title = nullable(primaryTitle);
      if (title === null) continue;

      const { rating, votes } = unpackRating(packed);
      const original = nullable(originalTitle);
      batch.push({
        imdb_id: tconst!,
        title,
        original_title: original !== null && original !== title ? original : null,
        year: nullableInt(startYear),
        runtime_min: nullableInt(runtime),
        genres: nullable(genres),
        rating,
        votes,
        title_type: titleType,
        end_year: titleType === "movie" ? null : nullableInt(endYear),
      });
      if (batch.length >= BATCH_SIZE) {
        await catalogue.insertStaging(batch);
        kept += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await catalogue.insertStaging(batch);
      kept += batch.length;
    }
    log(`  ${basicsStats.lines.toLocaleString()} lines, ${kept.toLocaleString()} movies kept`);

    // 3. Sanity checks before touching the live catalogue.
    const staged = await catalogue.countStaging();
    if (staged !== kept) throw new Error(`Staging has ${staged} rows, expected ${kept}`);
    if (staged === 0) throw new Error("Import produced an empty catalogue; refusing to swap");
    const previousRows = await catalogue.countMovies();
    if (!opts.force && previousRows > 0 && staged < previousRows * MIN_RETAINED_FRACTION) {
      throw new Error(
        `New catalogue has ${staged} movies vs ${previousRows} currently; refusing to swap ` +
          `(shrank by more than ${Math.round((1 - MIN_RETAINED_FRACTION) * 100)}%). Re-run with --force if intended.`,
      );
    }

    // 4. Atomic swap.
    await catalogue.swapStaging();
    const malformedLines = ratingsStats.malformed + basicsStats.malformed;
    await runs.finishRun(runId, {
      status: "success",
      rows: staged,
      ...(malformedLines > 0 ? { error: `${malformedLines} malformed lines skipped` } : {}),
    });
    log(`Swapped in ${staged.toLocaleString()} movies (previously ${previousRows.toLocaleString()}).`);

    return {
      runId,
      rows: staged,
      previousRows,
      ratingsLines: ratingsStats.lines,
      basicsLines: basicsStats.lines,
      malformedLines,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await catalogue.discardStaging().catch(() => {});
    await runs.finishRun(runId, { status: "failed", error: message }).catch(() => {});
    throw err;
  }
}

// Rating is stored x10 (10..100) in the low 7 bits; votes in the rest.
const packRating = (rating10: number, votes: number) => votes * 128 + rating10;
const unpackRating = (packed: number) => ({
  rating: (packed % 128) / 10,
  votes: Math.floor(packed / 128),
});
