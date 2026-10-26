/**
 * End-to-end check of the built stdio server (dist/) using the MCP client SDK,
 * the same way Claude Desktop / Claude Code talk to it.
 *
 *   npm run build && npx tsx scripts/smoke-stdio.ts [db-path]
 *
 * WRITES to the watched list (marks and unmarks a movie). Point it at a copy:
 *   sqlite3 data/movie-shelf.db ".backup /tmp/shelf-copy.db"
 *   npx tsx scripts/smoke-stdio.ts /tmp/shelf-copy.db
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("Usage: npx tsx scripts/smoke-stdio.ts <db-path>   (use a copy; this writes)");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/cli/mcp-stdio.js")],
  env: { ...(process.env as Record<string, string>), MOVIE_SHELF_DB: path.resolve(dbPath) },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

// biome-ignore lint: script
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const t = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t;
  if (res.isError) {
    console.log(`\n${name}(${JSON.stringify(args)}) -> ERROR (${ms}ms): ${(res.content as { text: string }[])[0]!.text}`);
    return null;
  }
  console.log(`\n${name}(${JSON.stringify(args)})  [${ms}ms]`);
  return res.structuredContent;
}
const line = (m: { title: string; year: number; language: string | null; genres: string[]; rating: number; votes: number; imdb_id: string }) =>
  `  ${m.title} (${m.year}) · ${m.language ?? "?"} · ${m.genres.join("/")} · ★${m.rating} · ${m.votes.toLocaleString()} votes · ${m.imdb_id}`;

const { tools } = await client.listTools();
console.log(`server: ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}; tools: ${tools.map((t) => t.name).join(", ")}`);

const r1 = await call("recommend", { language: "Malayalam", genre: "Thriller" });
console.log(`  showing ${r1.showing} of ${r1.total_matches}`);
r1.movies.forEach((m: never) => console.log(line(m)));
const ok1 = r1.movies.every((m: { language_code: string; genres: string[]; rating: number; votes: number }) =>
  m.language_code === "ml" && m.genres.includes("Thriller") && m.rating > 7 && m.votes >= 1000);
console.log(`  CHECK all Malayalam thrillers, >7.0, >=1000 votes: ${ok1 ? "PASS" : "FAIL"}`);

const pick = r1.movies[0];
await call("mark_watched", { imdb_id: pick.imdb_id });
const r2 = await call("recommend", { language: "ml", genre: "thriller", limit: 25 });
const r3 = await call("recommend", { language: "ml", genre: "thriller", limit: 25, sort: "shuffle" });
const gone = ![...r2.movies, ...r3.movies].some((m: { imdb_id: string }) => m.imdb_id === pick.imdb_id);
console.log(`  CHECK ${pick.title} gone after mark_watched (top + shuffle): ${gone ? "PASS" : "FAIL"}; total now ${r2.total_matches}`);

const d = await call("mark_watched", { title: "Drishyam" });
console.log(`  status=${d.status} written=${d.written}`);
d.candidates.forEach((m: never) => console.log(line(m)));
const dIds = d.candidates.map((c: { imdb_id: string }) => c.imdb_id);
console.log(`  CHECK Drishyam not written, both candidates: ${!d.written && dIds.includes("tt3417422") && dIds.includes("tt4430212") ? "PASS" : "FAIL"}`);

const k1 = await call("recommend", { language: "ko" });
const k2 = await call("recommend", { language: "Korean" });
console.log(`  CHECK ko == Korean: ${JSON.stringify(k1.movies) === JSON.stringify(k2.movies) ? "PASS" : "FAIL"} (${k1.total_matches} matches)`);
k1.movies.slice(0, 3).forEach((m: never) => console.log(line(m)));

const s = await call("search_title", { query: "parasite" });
s.results.forEach((m: never) => console.log(line(m)));

const l = await call("list_watched");
console.log(`  ${l.total} watched: ${l.entries.map((e: { title: string }) => e.title).join(", ")}`);
await call("unmark_watched", { imdb_id: pick.imdb_id });

await client.close();
