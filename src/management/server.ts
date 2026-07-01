/**
 * Management UI host.
 *
 * A small, opt-in HTTP server (started only when the owner calls the
 * open_management_ui tool) that serves a local, browser-based console over the
 * existing JournalStore. It is the owner's direct, non-LLM window onto the
 * journal — the counterpart to the LLM-mediated MCP tools.
 *
 * SECURITY (this is a plain HTTP server on the owner's machine):
 *  - Binds to localhost only (config.uiHost, default 127.0.0.1).
 *  - Every /api/* request must present a per-session token (random, generated at
 *    startup) via the `x-donguri-token` header or `?token=`. The token is
 *    compared in constant time.
 *  - The Host header is pinned to a loopback name, so a remote page cannot use
 *    DNS rebinding to reach the API through the victim's browser.
 *  - Read-only in this first slice: only GET, no mutations, and the entry data
 *    it serves never includes filesystem paths.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { type Server, type ServerResponse, createServer } from "node:http";
import { z } from "zod";
import type { JournalContext } from "../kernel/context.js";
import { renderApp } from "./ui.js";

export interface ManagementUi {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const entriesQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  source_kind: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  time_field: z.enum(["created_at", "occurred_at"]).optional(),
  limit: z.coerce.number().int().optional(),
  include_deleted: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const recallQuerySchema = z.object({
  q: z.string().min(1),
  k: z.coerce.number().int().optional(),
});

/** Constant-time token comparison that never throws on length mismatch. */
function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Reject requests whose Host header isn't a loopback name (DNS-rebinding guard). */
function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip the port; keep bracketed IPv6 intact.
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : (hostHeader.split(":")[0] ?? "");
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Build (but do not start) the management HTTP server. Exposed for tests, which
 * drive it on an ephemeral port. Production goes through startManagementUi.
 */
export function createManagementServer(ctx: JournalContext, token: string): Server {
  const { store, originals, config } = ctx;

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        sendJson(res, 421, { error: "Misdirected request" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const provided =
        (req.headers["x-donguri-token"] as string | undefined) ?? url.searchParams.get("token");
      const authorized = tokenMatches(token, provided ?? null);

      // The shell itself is token-gated so a co-resident local process can't load
      // it, read a baked-in token, and reach the API. The page then reuses the
      // ?token= from its own URL for /api/* calls.
      if (url.pathname === "/" && method === "GET") {
        if (!authorized) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end(
            "Unauthorized: open the URL printed by open_management_ui (it carries the token).",
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderApp());
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (method !== "GET") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        if (!authorized) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        if (url.pathname === "/api/entries") {
          const parsed = entriesQuerySchema.safeParse(Object.fromEntries(url.searchParams));
          if (!parsed.success) {
            sendJson(res, 400, { error: "Invalid query", issues: parsed.error.issues });
            return;
          }
          const entries = store.query(parsed.data);
          sendJson(res, 200, { count: entries.length, entries });
          return;
        }

        if (url.pathname === "/api/recall") {
          const parsed = recallQuerySchema.safeParse(Object.fromEntries(url.searchParams));
          if (!parsed.success) {
            sendJson(res, 400, { error: "Invalid query", issues: parsed.error.issues });
            return;
          }
          const hits = await store.recall(parsed.data.q, parsed.data.k);
          sendJson(res, 200, { count: hits.length, hits });
          return;
        }

        if (url.pathname === "/api/stats") {
          let dbBytes: number | null = null;
          try {
            dbBytes = statSync(config.dbPath).size;
          } catch {
            dbBytes = null;
          }
          sendJson(res, 200, {
            entries: store.entryStats(),
            originals: await originals.stats(),
            db_bytes: dbBytes,
          });
          return;
        }

        sendJson(res, 404, { error: "Not found" });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      ctx.log("management UI request failed:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal error" });
      } else {
        res.end();
      }
    }
  });
}

/**
 * Start the management UI on config.uiHost:uiPort (an ephemeral port by
 * default). Returns the URL (with the session token) to hand to the owner.
 */
export function startManagementUi(ctx: JournalContext): Promise<ManagementUi> {
  const token = randomBytes(24).toString("base64url");
  const server = createManagementServer(ctx, token);
  const { uiHost, uiPort } = ctx.config;

  return new Promise<ManagementUi>((resolve, reject) => {
    server.once("error", reject);
    server.listen(uiPort, uiHost, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : uiPort;
      // Bracket IPv6 hosts for the URL authority.
      const hostForUrl = uiHost.includes(":") ? `[${uiHost}]` : uiHost;
      const url = `http://${hostForUrl}:${port}/?token=${token}`;
      resolve({
        url,
        port,
        token,
        close: () =>
          new Promise<void>((res, rej) => {
            server.closeAllConnections();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
