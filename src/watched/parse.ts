import type { WatchedInput } from "../db/repository.js";
import { parseImdbId } from "../lib/text.js";
import { isIsoDate } from "../shelf/service.js";

/** RFC 4180 CSV: quoted fields, "" escapes, commas/newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const IMPORTABLE_TYPES = new Set(["movie", "tv series", "tv mini series"]);

export interface CsvImportPlan {
  entries: WatchedInput[];
  skipped: { line: number; title: string; reason: string }[];
}

/**
 * IMDb "Your Ratings" export. Uses Const as the imdb_id and reads Your Rating,
 * Date Rated and Year; only rows whose Title Type is a movie, TV series or
 * TV miniseries are kept (episodes, shorts and TV movies are skipped).
 */
export function planImdbRatingsCsv(text: string): CsvImportPlan {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error("CSV is empty");
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const idx = {
    const: col("Const"),
    rating: col("Your Rating"),
    dateRated: col("Date Rated"),
    title: col("Title"),
    titleType: col("Title Type"),
    year: col("Year"),
  };
  for (const required of ["const", "titleType"] as const) {
    if (idx[required] < 0) {
      throw new Error(`Not an IMDb ratings export: missing "${required === "const" ? "Const" : "Title Type"}" column`);
    }
  }

  const plan: CsvImportPlan = { entries: [], skipped: [] };
  rows.forEach((r, i) => {
    const line = i + 2;
    const get = (j: number) => (j >= 0 ? (r[j] ?? "").trim() : "");
    const title = get(idx.title);
    const type = get(idx.titleType);
    if (!IMPORTABLE_TYPES.has(type.toLowerCase())) {
      plan.skipped.push({ line, title, reason: `Title Type is "${type || "empty"}"` });
      return;
    }
    const id = parseImdbId(get(idx.const));
    if (!id) {
      plan.skipped.push({ line, title, reason: `invalid Const "${get(idx.const)}"` });
      return;
    }
    const rating = Number.parseFloat(get(idx.rating));
    const year = Number.parseInt(get(idx.year), 10);
    plan.entries.push({
      imdb_id: id,
      year: Number.isFinite(year) ? year : null,
      watched_on: toIsoDate(get(idx.dateRated)),
      my_rating: rating >= 1 && rating <= 10 ? rating : null,
      added_via: "import",
    });
  });
  return plan;
}

function toIsoDate(s: string): string | null {
  if (!s) return null;
  if (isIsoDate(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export interface TitleLine {
  line: number;
  raw: string;
  title: string;
  year?: number;
}

/**
 * One title per line, optional year: "Drishyam (2013)", "Drishyam, 2013",
 * "Drishyam 2013" or "Drishyam". Blank lines and lines starting with # are
 * ignored. A title that is itself a year ("1917", "2012") is kept as a title.
 */
export function parseTitleList(text: string): TitleLine[] {
  const maxYear = new Date().getFullYear() + 2;
  const out: TitleLine[] = [];
  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((rawLine, i) => {
      const raw = rawLine.trim();
      if (!raw || raw.startsWith("#")) return;
      const m = /^(.*?)[\s,;\-–(\[]*\b(1[89]\d{2}|2\d{3})\b[)\]]?\s*$/.exec(raw);
      if (m && m[1]!.trim() && Number(m[2]) <= maxYear && Number(m[2]) >= 1870) {
        out.push({ line: i + 1, raw, title: m[1]!.trim(), year: Number(m[2]) });
      } else {
        out.push({ line: i + 1, raw, title: raw });
      }
    });
  return out;
}
