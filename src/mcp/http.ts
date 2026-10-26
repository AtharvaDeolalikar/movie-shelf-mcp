import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ShelfService } from "../shelf/service.js";
import { SERVER_VERSION, createMcpServer } from "./server.js";

export interface HttpOptions {
  /** Shared secret; requests must send it as `Authorization: Bearer <token>` or `?token=<token>`. */
  token: string;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Bearer header, or `?token=` for clients that cannot set headers (claude.ai and
 * ChatGPT custom connectors only take a URL). Hashing first makes the comparison
 * constant-time regardless of length.
 */
function isAuthorized(req: IncomingMessage, url: URL, expected: Buffer): boolean {
  const header = req.headers.authorization;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7).trim() : url.searchParams.get("token");
  return supplied != null && timingSafeEqual(sha256(supplied), expected);
}

function sendJson(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

/**
 * Stateless Streamable HTTP: every POST to /mcp gets a fresh McpServer + transport
 * (cheap; the service and its DB connection are shared). GET /health is unauthenticated.
 */
export function createHttpHandler(service: ShelfService, options: HttpOptions): RequestListener {
  const expected = sha256(options.token);

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      // `commit` lets a deploy confirm the new release is the one answering.
      return sendJson(res, 200, { status: "ok", version: SERVER_VERSION, commit: process.env.APP_COMMIT ?? null });
    }
    if (url.pathname !== "/mcp") {
      return sendJson(res, 404, { error: "not found" });
    }
    if (!isAuthorized(req, url, expected)) {
      return sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    }
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
      return sendJson(
        res,
        405,
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        { Allow: "POST" },
      );
    }

    const server = createMcpServer(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[movie-shelf] http error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  };
}
