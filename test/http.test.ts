import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createShelfService } from "../src/app.js";
import type { Db } from "../src/db/sqlite.js";
import { openDatabase } from "../src/db/sqlite.js";
import { SqliteCatalogueRepository } from "../src/db/sqlite-repository.js";
import { createHttpHandler } from "../src/mcp/http.js";

const TOKEN = "test-token-0123456789abcdef0123456789";

describe("MCP over HTTP", () => {
  let db: Db;
  let server: Server;
  let base: string;

  before(async () => {
    db = openDatabase(":memory:");
    const catalogue = new SqliteCatalogueRepository(db);
    await catalogue.beginStaging();
    await catalogue.insertStaging([
      { imdb_id: "tt3417422", title: "Drishyam", original_title: null, year: 2013, runtime_min: 160, genres: "Crime,Drama,Thriller", rating: 8.4, votes: 50000, title_type: "movie", end_year: null },
    ]);
    await catalogue.swapStaging();
    server = createServer(createHttpHandler(createShelfService(db), { token: TOKEN }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  async function connect(url: string, headers: Record<string, string> = {}) {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
  }

  it("serves /health without auth", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; version: string; commit: string | null };
    assert.equal(body.status, "ok");
    assert.equal(body.version, "0.1.0");
    assert.ok("commit" in body);
  });

  it("rejects /mcp without a valid token", async () => {
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
    assert.equal((await fetch(`${base}/mcp`, init)).status, 401);
    assert.equal((await fetch(`${base}/mcp?token=wrong`, init)).status, 401);
    const bad = await fetch(`${base}/mcp`, { ...init, headers: { ...init.headers, Authorization: "Bearer wrong" } });
    assert.equal(bad.status, 401);
  });

  it("runs tools with a bearer token", async () => {
    const client = await connect(`${base}/mcp`, { Authorization: `Bearer ${TOKEN}` });
    const res = await client.callTool({ name: "search_title", arguments: { query: "Drishyam" } });
    assert.ok(!res.isError);
    assert.equal((res.structuredContent as { results: { imdb_id: string }[] }).results[0]!.imdb_id, "tt3417422");
    await client.close();
  });

  it("accepts the token as a query parameter", async () => {
    const client = await connect(`${base}/mcp?token=${TOKEN}`);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 8);
    await client.close();
  });

  it("returns 405 for GET /mcp (stateless, no SSE stream)", async () => {
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405);
  });
});
