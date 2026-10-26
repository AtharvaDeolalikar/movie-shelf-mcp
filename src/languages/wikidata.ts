import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { ImportRunRepository, LanguageRepository, LanguageRow } from "../db/repository.js";
import { readLines } from "../lib/lines.js";
import { isKnownLanguageCode } from "./normalise.js";

/**
 * Every item with an IMDb ID (P345) and original language (P364), mapped to
 * the language's ISO 639-1 code (P218). Not restricted to films: the join
 * with `movies` does that, and a P31/P279* filter would risk a timeout.
 */
function query(imdbPrefix?: string): string {
  const prefix = imdbPrefix ?? "tt";
  return `SELECT ?imdb ?code WHERE {
  ?item wdt:P345 ?imdb ; wdt:P364 ?lang .
  ?lang wdt:P218 ?code .
  FILTER(STRSTARTS(?imdb, "${prefix}"))
}`;
}

/** Shards used if the single query times out: tt0..., tt1..., ..., tt9... */
const SHARDS = Array.from({ length: 10 }, (_, i) => `tt${i}`);

export interface WikidataClientOptions {
  endpoint: string;
  userAgent: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  /** Per-request timeout; WDQS itself gives up at 60s. */
  timeoutMs?: number;
  /** Base delay between shard retries (grows linearly). */
  retryDelayMs?: number;
}

/** imdb_id -> set of ISO 639-1 codes. */
export type WikidataLanguages = Map<string, Set<string>>;

export async function fetchWikidataLanguages(opts: WikidataClientOptions): Promise<WikidataLanguages> {
  const log = opts.log ?? (() => {});
  const result: WikidataLanguages = new Map();
  try {
    await runQuery(opts, query(), result);
    return result;
  } catch (err) {
    log(`  Single Wikidata query failed (${errMessage(err)}); retrying in ${SHARDS.length} shards`);
  }
  result.clear();
  for (const shard of SHARDS) {
    await withRetries(() => runQuery(opts, query(shard), result), 3, opts.retryDelayMs ?? 5_000, log, `shard ${shard}`);
  }
  return result;
}

async function runQuery(opts: WikidataClientOptions, sparql: string, into: WikidataLanguages): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(opts.endpoint, {
    method: "POST",
    headers: {
      Accept: "text/tab-separated-values",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": opts.userAgent,
    },
    body: new URLSearchParams({ query: sparql }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`Wikidata SPARQL ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }

  let header = true;
  const stream = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  for await (const line of readLines(stream)) {
    if (header) {
      if (line !== "?imdb\t?code") throw new Error(`Unexpected Wikidata header: ${line}`);
      header = false;
      continue;
    }
    if (!line) continue;
    const [imdbRaw, codeRaw] = line.split("\t");
    const imdb = unquote(imdbRaw);
    const code = unquote(codeRaw)?.toLowerCase();
    if (!imdb || !code || !/^tt\d{7,}$/.test(imdb) || !isKnownLanguageCode(code)) continue;
    let codes = into.get(imdb);
    if (!codes) into.set(imdb, (codes = new Set()));
    codes.add(code);
  }
  if (header) throw new Error("Empty Wikidata response");
}

/** SPARQL TSV literals look like `"tt0111161"`, possibly with `@lang` / `^^type`. */
function unquote(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = /^"(.*)"(?:@[\w-]+|\^\^<[^>]+>)?$/.exec(v);
  return m ? m[1] : v;
}

async function withRetries<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
  log: (msg: string) => void,
  label: string,
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      const wait = delayMs * i;
      log(`  ${label} failed (${errMessage(err)}); retry ${i}/${attempts - 1} in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Refuse to apply a result that lost more than half of the current Wikidata rows. */
const MIN_RETAINED_FRACTION = 0.5;

export interface WikidataImportOptions {
  languages: LanguageRepository;
  runs: ImportRunRepository;
  client: WikidataClientOptions;
  force?: boolean;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface WikidataImportResult {
  runId: number;
  imdbIds: number;
  resolved: number;
  /** IMDb IDs with more than one original language; left for TMDB. */
  ambiguous: number;
  written: number;
  removed: number;
}

/**
 * Fetches the full Wikidata mapping, then replaces the Wikidata-sourced rows
 * in one transaction. Nothing is written unless the whole fetch succeeded, so
 * a truncated response can't record half of a multi-language film as
 * single-language.
 */
export async function importWikidataLanguages(opts: WikidataImportOptions): Promise<WikidataImportResult> {
  const log = opts.log ?? (() => {});
  const runId = await opts.runs.startRun("wikidata");
  try {
    log("Querying Wikidata ...");
    const map = await fetchWikidataLanguages({ ...opts.client, log });

    const rows: LanguageRow[] = [];
    let ambiguous = 0;
    for (const [imdb_id, codes] of map) {
      if (codes.size === 1) rows.push({ imdb_id, lang: codes.values().next().value! });
      else ambiguous++;
    }
    log(`  ${map.size.toLocaleString()} IMDb IDs: ${rows.length.toLocaleString()} single-language, ${ambiguous.toLocaleString()} multi-language (skipped)`);

    const current = await opts.languages.countBySource("wikidata");
    if (rows.length === 0) throw new Error("Wikidata returned no usable rows");
    if (!opts.force && current > 0 && rows.length < current * MIN_RETAINED_FRACTION) {
      throw new Error(
        `Wikidata returned ${rows.length} languages vs ${current} stored; refusing to apply. Re-run with --force if intended.`,
      );
    }

    const fetchedAt = (opts.now?.() ?? new Date()).toISOString();
    const { written, removed } = await opts.languages.replaceWikidata(rows, fetchedAt);
    await opts.runs.finishRun(runId, { status: "success", rows: rows.length });
    log(`  Stored ${written.toLocaleString()} rows, removed ${removed.toLocaleString()} stale Wikidata rows`);
    return { runId, imdbIds: map.size, resolved: rows.length, ambiguous, written, removed };
  } catch (err) {
    await opts.runs.finishRun(runId, { status: "failed", error: errMessage(err) }).catch(() => {});
    throw err;
  }
}
