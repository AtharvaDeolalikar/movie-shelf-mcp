/**
 * MCP server over Streamable HTTP (remote clients: claude.ai, ChatGPT connectors).
 * Serves POST /mcp (bearer auth) and GET /health.
 */
import { createServer } from "node:http";
import { createShelfService } from "../app.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/sqlite.js";
import { createHttpHandler } from "../mcp/http.js";

const config = loadConfig();
const token = process.env.MCP_AUTH_TOKEN?.trim();
if (!token || token.length < 32) {
  console.error("[movie-shelf] MCP_AUTH_TOKEN must be set to a random string of at least 32 characters.");
  process.exit(1);
}
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

const db = openDatabase(config.dbPath);
const movieCount = db.prepare("SELECT COUNT(*) FROM movies").pluck().get() as number;
if (movieCount === 0) {
  console.error("[movie-shelf] warning: the catalogue is empty; run `npm run import:imdb` first.");
}

const httpServer = createServer(createHttpHandler(createShelfService(db), { token }));
httpServer.listen(port, host, () => {
  console.error(`[movie-shelf] http server on ${host}:${port} (${movieCount.toLocaleString()} movies, db ${config.dbPath})`);
});

const shutdown = () => {
  httpServer.close(() => {
    db.close();
    process.exit(0);
  });
  httpServer.closeAllConnections();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
