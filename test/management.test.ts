/**
 * Management UI host: the localhost + token security boundary and the read-only
 * JSON API shape. Uses a raw http client so we can set arbitrary headers (Host,
 * token) that fetch would otherwise pin.
 */
import assert from "node:assert/strict";
import { type IncomingHttpHeaders, request } from "node:http";
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
  headers: IncomingHttpHeaders;
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
          headers: res.headers,
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

    const config: JournalConfig = {
      dbPath,
      originalsDir: tmp.file("originals"),
      maxOriginalBytes: 25 * 1024 * 1024,
      pluginsDir: tmp.file("plugins"),
      pluginsConfigPath: tmp.file("plugins.json"),
      uiHost: "127.0.0.1",
      uiPort: 0,
    };
    const ctx: JournalContext = {
      server: undefined as unknown as McpServer,
      store,
      originals: new LocalDirStore(tmp.file("originals")),
      config,
      log: () => {},
      storage: (id) => store.moduleStorage(id),
      onEntryPurged: (hook) => store.onEntryPurged(hook),
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
    assert.equal(res.headers["cache-control"], "no-store");
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
    assert.equal(res.headers["cache-control"], "no-store");
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
    assert.equal(body.count, 1);
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

describe("management UI writes + export", () => {
  let tmp: TempDir;
  let ui: ManagementUi;
  let token: string;
  let port: number;
  let store: JournalStore;
  let originals: LocalDirStore;
  let plainId: number;
  let withOriginalId: number;
  let originalRef: string;

  before(async () => {
    tmp = makeTempDir();
    const dbPath = tmp.file("journal.db");
    store = new JournalStore(dbPath, new FakeEmbedder());
    store.init();
    originals = new LocalDirStore(tmp.file("originals"));

    // Fixture entries are per-test where possible; these two are only ever
    // touched by the tests that own them, so ordering doesn't matter.
    const plain = await store.insert({ body: "plain note", source_kind: "note" });
    plainId = plain.id;
    const saved = await originals.save({ data: Buffer.from("secret bytes"), mime: "text/plain" });
    originalRef = saved.ref;
    const withOriginal = await store.insert({
      body: "note with original",
      source_kind: "file",
      original_ref: originalRef,
    });
    withOriginalId = withOriginal.id;

    const config: JournalConfig = {
      dbPath,
      originalsDir: tmp.file("originals"),
      maxOriginalBytes: 25 * 1024 * 1024,
      pluginsDir: tmp.file("plugins"),
      pluginsConfigPath: tmp.file("plugins.json"),
      uiHost: "127.0.0.1",
      uiPort: 0,
    };
    const ctx: JournalContext = {
      server: undefined as unknown as McpServer,
      store,
      originals,
      config,
      log: () => {},
      storage: (id) => store.moduleStorage(id),
      onEntryPurged: (hook) => store.onEntryPurged(hook),
    };
    ui = await startManagementUi(ctx);
    token = ui.token;
    port = ui.port;
  });

  after(async () => {
    await ui.close();
    tmp.cleanup();
  });

  it("streams a lossless NDJSON export with meta, entries and links", async () => {
    const older = await store.insert({ body: "export probe origin" });
    const newer = await store.insert({
      body: "export probe successor",
      links: [{ rel: "continues", to: older.id }],
    });
    const res = await httpGet(port, "/api/export", { "x-donguri-token": token });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /application\/x-ndjson/);
    assert.match(
      String(res.headers["content-disposition"]),
      /attachment; filename="donguri-journal-/,
    );
    assert.equal(res.headers["cache-control"], "no-store");
    const lines = res.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines[0]?.type, "meta");
    assert.equal(lines[0]?.format, "donguri-journal-export");
    const bodies = lines.filter((l) => l.type === "entry").map((l) => l.body);
    assert.ok(bodies.includes("export probe origin"));
    assert.ok(bodies.includes("export probe successor"));
    const links = lines.filter((l) => l.type === "link");
    assert.ok(
      links.some((l) => l.from_id === newer.id && l.rel === "continues" && l.to_id === older.id),
    );
  });

  it("export can exclude soft-deleted entries — and links pointing at them", async () => {
    const doomed = await store.insert({ body: "export tombstone probe" });
    const pointer = await store.insert({
      body: "export tombstone pointer",
      links: [{ rel: "references", to: doomed.id }],
    });
    store.softDelete(doomed.id);
    const all = await httpGet(port, "/api/export?include_deleted=true", {
      "x-donguri-token": token,
    });
    const active = await httpGet(port, "/api/export?include_deleted=false", {
      "x-donguri-token": token,
    });
    assert.ok(all.body.includes("export tombstone probe"));
    assert.ok(!active.body.includes("export tombstone probe"));
    // The pointer entry survives, but its edge to the excluded entry must not
    // dangle in the filtered export.
    const hasEdge = (body: string): boolean =>
      body
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .some((l) => l.type === "link" && l.from_id === pointer.id && l.to_id === doomed.id);
    assert.equal(hasEdge(all.body), true);
    assert.equal(hasEdge(active.body), false);
  });

  it("serves original bytes by ref and 404s unknown refs", async () => {
    const saved = await originals.save({
      data: Buffer.from("download probe bytes"),
      mime: "text/plain",
    });
    const res = await httpGet(port, `/api/original?ref=${encodeURIComponent(saved.ref)}`, {
      "x-donguri-token": token,
    });
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/plain/);
    assert.equal(res.body, "download probe bytes");
    const missing = await httpGet(port, `/api/original?ref=local:${"0".repeat(64)}`, {
      "x-donguri-token": token,
    });
    assert.equal(missing.status, 404);
  });

  it("rejects deletes without a token and GETs on the delete route", async () => {
    const noToken = await httpGet(port, `/api/entries/${plainId}/delete?mode=soft`, {}, "POST");
    assert.equal(noToken.status, 401);
    const wrongMethod = await httpGet(port, `/api/entries/${plainId}/delete?mode=soft`, {
      "x-donguri-token": token,
    });
    assert.equal(wrongMethod.status, 405);
    const badMode = await httpGet(
      port,
      `/api/entries/${plainId}/delete?mode=shred`,
      { "x-donguri-token": token },
      "POST",
    );
    assert.equal(badMode.status, 400);
  });

  it("soft delete tombstones the entry (recoverable, hidden by default)", async () => {
    const target = await store.insert({ body: "soft delete probe" });
    const res = await httpGet(
      port,
      `/api/entries/${target.id}/delete?mode=soft`,
      { "x-donguri-token": token },
      "POST",
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { id: target.id, mode: "soft", deleted: true });
    assert.equal(store.getEntry(target.id), null);
    assert.ok(store.getEntry(target.id, { include_deleted: true }));
  });

  it("hard delete purges the entry and erases its orphaned original", async () => {
    const res = await httpGet(
      port,
      `/api/entries/${withOriginalId}/delete?mode=hard`,
      { "x-donguri-token": token },
      "POST",
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { id: withOriginalId, mode: "hard", deleted: true });
    assert.equal(store.getEntry(withOriginalId, { include_deleted: true }), null);
    assert.equal(await originals.get(originalRef), null);
  });
});

describe("management UI bind safety", () => {
  it("refuses a non-loopback uiHost and binds 127.0.0.1 instead", async () => {
    const tmp = makeTempDir();
    try {
      const dbPath = tmp.file("journal.db");
      const store = new JournalStore(dbPath, new FakeEmbedder());
      store.init();
      const config: JournalConfig = {
        dbPath,
        originalsDir: tmp.file("originals"),
        maxOriginalBytes: 25 * 1024 * 1024,
        pluginsDir: tmp.file("plugins"),
        pluginsConfigPath: tmp.file("plugins.json"),
        uiHost: "0.0.0.0",
        uiPort: 0,
      };
      const ctx: JournalContext = {
        server: undefined as unknown as McpServer,
        store,
        originals: new LocalDirStore(tmp.file("originals")),
        config,
        log: () => {},
        storage: (id) => store.moduleStorage(id),
        onEntryPurged: (hook) => store.onEntryPurged(hook),
      };
      const ui = await startManagementUi(ctx);
      assert.match(ui.url, /^http:\/\/127\.0\.0\.1:/);
      const res = await httpGet(ui.port, `/?token=${ui.token}`);
      assert.equal(res.status, 200);
      await ui.close();
    } finally {
      tmp.cleanup();
    }
  });
});
