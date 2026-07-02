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
 *  - Mutations are POST-only and limited to entry deletion (the owner deleting
 *    their own data). Export/download endpoints stream raw journal data to the
 *    owner's browser — deliberately NOT through the LLM. Entry data never
 *    includes filesystem paths.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { type Server, type ServerResponse, createServer } from "node:http";
import { isIP } from "node:net";
import { z } from "zod";
import { hardDeleteEntry } from "../db/deletion.js";
import type { JournalContext } from "../kernel/context.js";
import { SERVER_VERSION } from "../kernel/version.js";
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

/**
 * Is this a host we're willing to bind to? Loopback only — the Host-header check
 * is a browser-side DNS-rebinding guard, NOT a substitute for the bind range, so
 * we refuse to expose the socket on an external interface (e.g. 0.0.0.0).
 */
function isBindableLoopback(host: string): boolean {
  // `host` is the bare literal (brackets already stripped by the caller), since
  // Node's listen() takes a raw IP, not the URL/bracketed form.
  const h = host.toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  // Any real IPv4 literal in 127.0.0.0/8. isIP() rejects malformed octets (e.g.
  // 127.999.999.999) that a loose regex would wrongly accept.
  return isIP(h) === 4 && h.startsWith("127.");
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
    // no-store: responses can carry journal bodies; keep them out of any cache.
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
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
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(renderApp());
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!authorized) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        // The one mutating route: POST /api/entries/<id>/delete?mode=soft|hard.
        // Deletion is the owner erasing their own data; hard mode reuses the
        // original-first orchestration shared with the delete_entry MCP tool.
        const deleteMatch = url.pathname.match(/^\/api\/entries\/(\d+)\/delete$/);
        if (deleteMatch) {
          if (method !== "POST") {
            sendJson(res, 405, { error: "Method not allowed" });
            return;
          }
          const id = Number(deleteMatch[1]);
          const mode = url.searchParams.get("mode") ?? "soft";
          if (mode !== "soft" && mode !== "hard") {
            sendJson(res, 400, { error: "mode must be 'soft' or 'hard'" });
            return;
          }
          if (mode === "soft") {
            sendJson(res, 200, { id, mode, deleted: store.softDelete(id) });
            return;
          }
          const outcome = await hardDeleteEntry(store, originals, ctx.log, id);
          if (!outcome.ok) {
            sendJson(res, 500, { error: outcome.message });
            return;
          }
          sendJson(res, 200, { id, mode, deleted: outcome.deleted });
          return;
        }

        if (method !== "GET") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        // Lossless NDJSON export, streamed straight to the owner's browser —
        // bulk data stays out of the LLM context by design.
        if (url.pathname === "/api/export") {
          const includeDeleted = url.searchParams.get("include_deleted") !== "false";
          const stamp = new Date().toISOString().slice(0, 10);
          res.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "content-disposition": `attachment; filename="donguri-journal-${stamp}.ndjson"`,
            "cache-control": "no-store",
          });
          // Honor backpressure: when write() reports a full buffer, wait for
          // drain (or the client going away) before producing more rows.
          const line = async (obj: unknown): Promise<boolean> => {
            if (res.destroyed) return false;
            if (!res.write(`${JSON.stringify(obj)}\n`)) {
              await new Promise<void>((resolve) => {
                const done = (): void => {
                  res.off("drain", done);
                  res.off("close", done);
                  resolve();
                };
                res.once("drain", done);
                res.once("close", done);
              });
            }
            return !res.destroyed;
          };
          await line({
            type: "meta",
            format: "donguri-journal-export",
            format_version: 1,
            server_version: SERVER_VERSION,
            exported_at: new Date().toISOString(),
            include_deleted: includeDeleted,
          });
          // When tombstones are excluded, links must be too, or the export
          // would carry edges whose endpoints aren't in the file.
          const exportedIds = includeDeleted ? null : new Set<number>();
          for (const entry of store.iterateEntries({ include_deleted: includeDeleted })) {
            exportedIds?.add(entry.id);
            if (!(await line({ type: "entry", ...entry }))) return;
          }
          for (const link of store.iterateLinks()) {
            if (exportedIds && !(exportedIds.has(link.from_id) && exportedIds.has(link.to_id))) {
              continue;
            }
            if (!(await line({ type: "link", ...link }))) return;
          }
          res.end();
          return;
        }

        // Original bytes by ref (content-addressed; get() validates the ref
        // shape, so no path can be constructed from user input).
        if (url.pathname === "/api/original") {
          const ref = url.searchParams.get("ref") ?? "";
          const loaded = await originals.get(ref);
          if (!loaded) {
            sendJson(res, 404, { error: "Original not found" });
            return;
          }
          res.writeHead(200, {
            "content-type": loaded.mime ?? "application/octet-stream",
            "content-disposition": `attachment; filename="${ref.replace(/[^a-z0-9:]/gi, "").slice(-16)}"`,
            "cache-control": "no-store",
          });
          res.end(loaded.data);
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
  const { uiPort } = ctx.config;
  // Node's listen() wants a raw IP literal (`::1`), not the bracketed URL form
  // (`[::1]`); strip brackets before validating/binding.
  const configured = ctx.config.uiHost;
  const bareHost =
    configured.startsWith("[") && configured.endsWith("]") ? configured.slice(1, -1) : configured;
  // Enforce localhost-only at the bind boundary; a non-loopback config value is
  // refused (not silently honored) so the journal can't be exposed on the LAN.
  const uiHost = isBindableLoopback(bareHost) ? bareHost : "127.0.0.1";
  if (uiHost !== bareHost) {
    ctx.log(
      `refusing to bind management UI to non-loopback host "${configured}"; using 127.0.0.1 (localhost-only by design)`,
    );
  }

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
