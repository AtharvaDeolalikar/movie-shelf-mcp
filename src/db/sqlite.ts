import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normaliseTitle } from "../lib/text.js";
import { MIGRATIONS } from "./schema.js";

export type Db = Database.Database;

/** Opens (creating if needed) the SQLite database and applies migrations. */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  // WAL lets the MCP server keep reading the old catalogue while an import runs.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.function("norm_title", { deterministic: true }, (s: unknown) =>
    typeof s === "string" ? normaliseTitle(s) : null,
  );
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
