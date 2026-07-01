/**
 * Management UI host: the localhost + token security boundary and the read-only
 * JSON API shape. Uses a raw http client so we can set arbitrary headers (Host,
 * token) that fetch would otherwise pin.
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JournalStore } from "../src/db/store.js";
import type { JournalConfig } from "../src/kernel/config.js";
import type { JournalContext } from "../src/kernel/context.js";
import { type ManagementUi, startManagementUi } from "../src/management/server.js";
import { LocalDirStore } from "../src/originals/store.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

interface Res {
  status: number;
  contentType: string;
  body: string;
  json: () => unknown;
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"] ?? "",
          body,
          json: () => JSON.parse(body),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("management UI host", () => {
  let tmp: TempDir;
  let ui: ManagementUi;
  let token: string;
  let port: number;

  before(async () => {
    tmp = makeTempDir();
    const dbPath = tmp.file("journal.db");
    const store = new JournalStore(dbPath, new FakeEmbedder());
    store.init();
    await store.insert({ body: "the cat sat on the mat", tags: ["pets"], source_kind: "note" });
    await store.insert({ body: "quantum notes", tags: ["physics"], source_kind: "note" });
    const del = await store.insert({ body: "secret to remove", source_kind: "note" });
    store.softDelete(del.id);

    const config = {
      dbPath,
      originalsDir: tmp.file("originals"),
      uiHost: "127.0.0.1",
      uiPort: 0,
    } as JournalConfig;
    const ctx: JournalContext = {
      server: undefined as unknown as McpServer,
      store,
      originals: new LocalDirStore(tmp.file("originals")),
      config,
      log: () => {},
    };
    ui = await startManagementUi(ctx);
    token = ui.token;
    port = ui.port;
  });

  after(async () => {
    await ui.close();
    tmp.cleanup();
  });

  it("serves the SPA shell at / with a valid token", async () => {
    const res = await httpGet(port, `/?token=${token}`);
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/html/);
    assert.match(res.body, /donguri-journal/);
  });

  it("rejects / without a token", async () => {
    const res = await httpGet(port, "/");
    assert.equal(res.status, 401);
  });

  it("rejects /api without a token", async () => {
    const res = await httpGet(port, "/api/entries");
    assert.equal(res.status, 401);
  });

  it("rejects a non-loopback Host header (DNS-rebinding guard)", async () => {
    const res = await httpGet(port, `/?token=${token}`, { Host: "evil.example.com" });
    assert.equal(res.status, 421);
  });

  it("rejects non-GET methods on the API", async () => {
    const res = await httpGet(port, "/api/entries", { "x-donguri-token": token }, "POST");
    assert.equal(res.status, 405);
  });

  it("lists active entries and hides soft-deleted by default", async () => {
    const res = await httpGet(port, "/api/entries", { "x-donguri-token": token });
    assert.equal(res.status, 200);
    const body = res.json() as { count: number; entries: Array<{ body: string }> };
    assert.equal(body.count, 2);
    assert.ok(!body.entries.some((e) => e.body === "secret to remove"));
  });

  it("includes soft-deleted when asked", async () => {
    const res = await httpGet(port, "/api/entries?include_deleted=true", {
      "x-donguri-token": token,
    });
    const body = res.json() as { count: number };
    assert.equal(body.count, 3);
  });

  it("filters by tag", async () => {
    const res = await httpGet(port, "/api/entries?tag=physics", { "x-donguri-token": token });
    const body = res.json() as { count: number; entries: Array<{ body: string }> };
    assert.equal(body.count, 1);
    assert.equal(body.entries[0]?.body, "quantum notes");
  });

  it("400s on a malformed since timestamp", async () => {
    const res = await httpGet(port, "/api/entries?since=not-a-date", { "x-donguri-token": token });
    assert.equal(res.status, 400);
  });

  it("recalls by meaning via /api/recall", async () => {
    const res = await httpGet(port, "/api/recall?q=a%20cat%20on%20a%20mat&k=1", {
      "x-donguri-token": token,
    });
    assert.equal(res.status, 200);
    const body = res.json() as { count: number; hits: Array<{ body: string }> };
    assert.equal(body.hits[0]?.body, "the cat sat on the mat");
  });

  it("reports storage stats", async () => {
    const res = await httpGet(port, "/api/stats", { "x-donguri-token": token });
    assert.equal(res.status, 200);
    const body = res.json() as { entries: { active: number; soft_deleted: number } };
    assert.equal(body.entries.active, 2);
    assert.equal(body.entries.soft_deleted, 1);
  });

  it("404s an unknown API route", async () => {
    const res = await httpGet(port, "/api/nope", { "x-donguri-token": token });
    assert.equal(res.status, 404);
  });
});
