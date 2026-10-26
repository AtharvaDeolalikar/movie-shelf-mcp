import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { gunzip, readLines } from "../lib/lines.js";

export const IMDB_FILES = {
  basics: "title.basics.tsv.gz",
  ratings: "title.ratings.tsv.gz",
} as const;
export type ImdbFile = (typeof IMDB_FILES)[keyof typeof IMDB_FILES];

/** Returns the raw (still gzipped) byte stream for a dataset file. */
export type SourceOpener = (file: ImdbFile) => Promise<Readable>;

export function httpSource(baseUrl: string): SourceOpener {
  return async (file) => {
    const url = `${baseUrl}/${file}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  };
}

/** Reads already-downloaded dataset files from a local directory. */
export function directorySource(dir: string): SourceOpener {
  return async (file) => fs.createReadStream(path.join(dir, file));
}

export interface TsvStats {
  lines: number;
  malformed: number;
}

/**
 * Yields the fields of each data row of an IMDb TSV file. The header must
 * match `columns` exactly so an upstream format change fails loudly instead of
 * silently importing garbage. Rows with the wrong field count are skipped and
 * counted in `stats.malformed`.
 */
export async function* readImdbTsv(
  gz: Readable,
  columns: readonly string[],
  stats: TsvStats = { lines: 0, malformed: 0 },
): AsyncGenerator<string[]> {
  let headerSeen = false;
  for await (const line of readLines(gunzip(gz))) {
    if (!headerSeen) {
      const header = line.split("\t");
      if (header.join("\t") !== columns.join("\t")) {
        throw new Error(
          `Unexpected IMDb header: got [${header.join(", ")}], expected [${columns.join(", ")}]`,
        );
      }
      headerSeen = true;
      continue;
    }
    if (line.length === 0) continue;
    stats.lines++;
    const fields = line.split("\t");
    if (fields.length !== columns.length) {
      stats.malformed++;
      continue;
    }
    yield fields;
  }
  if (!headerSeen) throw new Error("IMDb file is empty");
}

/** IMDb uses `\N` for null. */
export function nullable(value: string | undefined): string | null {
  return value === undefined || value === "\\N" || value === "" ? null : value;
}

export function nullableInt(value: string | undefined): number | null {
  const v = nullable(value);
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
