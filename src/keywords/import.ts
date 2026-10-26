import type { ImportRunRepository, KeywordRepository } from "../db/repository.js";
import type { TmdbClient, TmdbKeywordsResult } from "../languages/tmdb.js";

export interface KeywordImportOptions {
  keywords: KeywordRepository;
  runs: ImportRunRepository;
  client: Pick<TmdbClient, "findKeywords">;
  minRating: number;
  minVotes: number;
  /** Re-query misses (not on TMDB) older than this. */
  retryAfterDays?: number;
  limit?: number;
  concurrency?: number;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface KeywordImportResult {
  runId: number;
  candidates: number;
  found: number;
  notFound: number;
}

/**
 * Fetches TMDB keywords for movies passing the default recommend filter that
 * have none yet. Each lookup is stored as it completes, so an aborted run
 * keeps its progress and the next run resumes.
 */
export async function importTmdbKeywords(opts: KeywordImportOptions): Promise<KeywordImportResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const runId = await opts.runs.startRun("keywords");
  const counts = { found: 0, notFound: 0 };
  try {
    const retryBefore = new Date(now().getTime() - (opts.retryAfterDays ?? 30) * 86_400_000).toISOString();
    const candidates = await opts.keywords.keywordCandidates({
      minRating: opts.minRating,
      minVotes: opts.minVotes,
      retryBefore,
      limit: opts.limit ?? 100_000,
    });
    log(`TMDB keywords: ${candidates.length.toLocaleString()} movies to look up`);

    let next = 0;
    let done = 0;
    let aborted = false;
    const worker = async () => {
      while (!aborted && next < candidates.length) {
        const imdbId = candidates[next++]!;
        let result: TmdbKeywordsResult;
        try {
          result = await opts.client.findKeywords(imdbId);
        } catch (err) {
          aborted = true; // stop the other workers too
          throw err;
        }
        await opts.keywords.recordKeywords(
          imdbId,
          result.status,
          result.status === "found" ? result.keywords : [],
          now().toISOString(),
        );
        if (result.status === "found") counts.found++;
        else counts.notFound++;
        if (++done % 250 === 0) log(`  ${done.toLocaleString()}/${candidates.length.toLocaleString()} looked up`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, candidates.length) }, worker));

    await opts.runs.finishRun(runId, { status: "success", rows: counts.found });
    log(`  found ${counts.found}, not on TMDB ${counts.notFound}`);
    return { runId, candidates: candidates.length, ...counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await opts.runs.finishRun(runId, { status: "failed", rows: counts.found, error: message }).catch(() => {});
    throw err;
  }
}
