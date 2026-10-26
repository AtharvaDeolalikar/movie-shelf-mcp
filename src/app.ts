import type { Db } from "./db/sqlite.js";
import { SqliteMovieRepository, SqliteWatchedRepository, SqliteWatchlistRepository } from "./db/sqlite-repository.js";
import { ShelfService } from "./shelf/service.js";

/** Wires the SQLite repositories into the service used by MCP tools and CLIs. */
export function createShelfService(db: Db): ShelfService {
  return new ShelfService(
    new SqliteMovieRepository(db),
    new SqliteWatchedRepository(db),
    new SqliteWatchlistRepository(db),
  );
}
