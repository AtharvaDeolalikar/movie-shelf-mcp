import type { ImportRunRepository, LanguageRepository, TmdbLookupStatus } from "../db/repository.js";
import { isKnownLanguageCode } from "./normalise.js";

export type TmdbFindResult =
  | { status: "found"; lang: string }
  | { status: Exclude<TmdbLookupStatus, "found"> };

export type TmdbKeywordsResult = { status: "found"; keywords: string[] } | { status: "not_found" };

export class TmdbAuthError extends Error {}

export interface TmdbClientOptions {
  apiKey: string;
  userAgent: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Average request rate cap; TMDB allows roughly 40-50/s per IP. */
  requestsPerSecond?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Minimal TMDB client for the `find` and keywords endpoints, with rate limiting and retries. */
export class TmdbClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextSlot = 0;

  constructor(private readonly opts: TmdbClientOptions) {
    this.baseUrl = (opts.baseUrl ?? "https://api.themoviedb.org/3").replace(/\/+$/, "");
    this.fetch = opts.fetch ?? fetch;
    this.minIntervalMs = 1000 / (opts.requestsPerSecond ?? 20);
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async findOriginalLanguage(imdbId: string): Promise<TmdbFindResult> {
    const body = (await this.getJson(`/find/${encodeURIComponent(imdbId)}`, { external_source: "imdb_id" }, imdbId)) as
      | { movie_results?: { original_language?: string }[]; tv_results?: { original_language?: string }[] }
      | null;
    // A movie ID comes back in movie_results, a series ID in tv_results.
    const title = body?.movie_results?.[0] ?? body?.tv_results?.[0];
    if (!title) return { status: "not_found" };
    const lang = title.original_language?.toLowerCase();
    // "xx" = "No Language" (silent films, etc.)
    if (!lang || lang === "xx" || !isKnownLanguageCode(lang)) return { status: "no_language" };
    return { status: "found", lang };
  }

  /**
   * Looks the title up by IMDb ID, then reads its TMDB keywords (lowercased,
   * deduplicated). Movies and series use different endpoints and response keys.
   */
  async findKeywords(imdbId: string): Promise<TmdbKeywordsResult> {
    const found = (await this.getJson(`/find/${encodeURIComponent(imdbId)}`, { external_source: "imdb_id" }, imdbId)) as
      | { movie_results?: { id?: number }[]; tv_results?: { id?: number }[] }
      | null;
    const movieId = found?.movie_results?.[0]?.id;
    const tvId = found?.tv_results?.[0]?.id;
    const [kind, tmdbId] = typeof movieId === "number" ? (["movie", movieId] as const) : (["tv", tvId] as const);
    if (typeof tmdbId !== "number") return { status: "not_found" };
    const body = (await this.getJson(`/${kind}/${tmdbId}/keywords`, {}, imdbId)) as
      | { keywords?: { name?: string }[]; results?: { name?: string }[] }
      | null;
    if (!body) return { status: "not_found" };
    const keywords = ((kind === "movie" ? body.keywords : body.results) ?? [])
      .map((k) => k.name?.trim().toLowerCase() ?? "")
      .filter((k) => k !== "");
    return { status: "found", keywords: [...new Set(keywords)] };
  }

  /** GET with auth, throttling and retries; null on 404. */
  private async getJson(path: string, params: Record<string, string>, label: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": this.opts.userAgent };
    // v4 read access tokens are JWTs; v3 keys are 32 hex chars.
    if (this.opts.apiKey.startsWith("eyJ")) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    else url.searchParams.set("api_key", this.opts.apiKey);

    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await this.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        if (attempt >= this.maxAttempts) throw err;
        await this.sleep(backoff(attempt));
        continue;
      }

      if (res.status === 401) {
        throw new TmdbAuthError("TMDB rejected the API key (401). Check TMDB_API_KEY.");
      }
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxAttempts) throw new Error(`TMDB ${res.status} after ${attempt} attempts`);
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      if (!res.ok) throw new Error(`TMDB ${res.status} ${res.statusText} for ${label}`);
      return res.json();
    }
  }

  /** Spaces request starts at least `minIntervalMs` apart across concurrent callers. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }
}

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1));

export interface TmdbImportOptions {
  languages: LanguageRepository;
  runs: ImportRunRepository;
  client: Pick<TmdbClient, "findOriginalLanguage">;
  minRating: number;
  minVotes: number;
  /** Re-query misses (not_found / no_language) older than this. */
  retryAfterDays?: number;
  limit?: number;
  concurrency?: number;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface TmdbImportResult {
  runId: number;
  candidates: number;
  found: number;
  notFound: number;
  noLanguage: number;
}

/**
 * Looks up the original language on TMDB for movies passing the default
 * recommend filter that still have none. Each lookup is stored as it
 * completes, so an aborted run keeps its progress and the next run resumes.
 */
export async function importTmdbLanguages(opts: TmdbImportOptions): Promise<TmdbImportResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const runId = await opts.runs.startRun("tmdb");
  const counts = { found: 0, notFound: 0, noLanguage: 0 };
  try {
    const retryBefore = new Date(now().getTime() - (opts.retryAfterDays ?? 30) * 86_400_000).toISOString();
    const candidates = await opts.languages.tmdbCandidates({
      minRating: opts.minRating,
      minVotes: opts.minVotes,
      retryBefore,
      limit: opts.limit ?? 100_000,
    });
    log(`TMDB fallback: ${candidates.length.toLocaleString()} movies without a language`);

    let next = 0;
    let done = 0;
    let aborted = false;
    const worker = async () => {
      while (!aborted && next < candidates.length) {
        const imdbId = candidates[next++]!;
        let result: TmdbFindResult;
        try {
          result = await opts.client.findOriginalLanguage(imdbId);
        } catch (err) {
          aborted = true; // stop the other workers too
          throw err;
        }
        await opts.languages.recordTmdbLookup(
          imdbId,
          result.status,
          result.status === "found" ? result.lang : null,
          now().toISOString(),
        );
        if (result.status === "found") counts.found++;
        else if (result.status === "not_found") counts.notFound++;
        else counts.noLanguage++;
        if (++done % 250 === 0) log(`  ${done.toLocaleString()}/${candidates.length.toLocaleString()} looked up`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, candidates.length) }, worker));

    await opts.runs.finishRun(runId, { status: "success", rows: counts.found });
    log(`  found ${counts.found}, not on TMDB ${counts.notFound}, no language ${counts.noLanguage}`);
    return { runId, candidates: candidates.length, ...counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await opts.runs
      .finishRun(runId, { status: "failed", rows: counts.found, error: message })
      .catch(() => {});
    throw err;
  }
}
