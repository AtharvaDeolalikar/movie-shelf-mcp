/**
 * MCP server over stdio (Claude Desktop, Claude Code, MCP Inspector, Cursor...).
 * stdout carries the protocol, so all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createShelfService } from "../app.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db/sqlite.js";
import { createMcpServer } from "../mcp/server.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const movieCount = db.prepare("SELECT COUNT(*) FROM movies").pluck().get() as number;
if (movieCount === 0) {
  console.error("[movie-shelf] warning: the catalogue is empty; run `npm run import:imdb` first.");
}

const server = createMcpServer(createShelfService(db));
await server.connect(new StdioServerTransport());
console.error(`[movie-shelf] stdio server ready (${movieCount.toLocaleString()} movies, db ${config.dbPath})`);

const shutdown = async () => {
  await server.close().catch(() => {});
  db.close();
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
