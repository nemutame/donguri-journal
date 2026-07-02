/**
 * Module storage: namespaced ext_ tables for opt-in modules, private schema
 * versions that never touch the core version, and purge hooks that erase
 * module references atomically with a hard delete.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SCHEMA_VERSION } from "../src/db/schema.js";
import { JournalStore } from "../src/db/store.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

function freshStore(tmp: TempDir): JournalStore {
  const store = new JournalStore(
    tmp.file(`storage-${Math.random().toString(36).slice(2)}.db`),
    new FakeEmbedder(),
  );
  store.init();
  return store;
}

describe("moduleStorage", () => {
  let tmp: TempDir;
  before(() => {
    tmp = makeTempDir();
  });
  after(() => {
    tmp.cleanup();
  });

  it("namespaces table names and validates identifiers", () => {
    const store = freshStore(tmp);
    const storage = store.moduleStorage("my-lens");
    assert.equal(storage.prefix, "ext_my_lens_");
    assert.equal(storage.tableName("collections"), "ext_my_lens_collections");
    assert.throws(() => storage.tableName("Bad Name"), /invalid module table name/);
    assert.throws(() => storage.tableName("drop table;--"), /invalid module table name/);
    assert.throws(() => store.moduleStorage("Bad Id!"), /invalid module id/);
    // Underscores are rejected in module ids, so the hyphen→underscore prefix
    // mapping is injective: "my_lens" can never collide with "my-lens".
    assert.throws(() => store.moduleStorage("my_lens"), /invalid module id/);
    store.close();
  });

  it("keeps a per-module schema version without touching the core version", () => {
    const store = freshStore(tmp);
    const storage = store.moduleStorage("bujo");
    assert.equal(storage.getVersion(), 0, "unset version reads as 0");
    storage.setVersion(2);
    assert.equal(storage.getVersion(), 2);
    assert.throws(() => storage.setVersion(-1), /invalid module schema version/);

    // The core schema version is untouched by module versions.
    const core = storage.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
      value: string;
    };
    assert.equal(core.value, String(SCHEMA_VERSION));
    store.close();
  });

  it("module tables survive round trips and a purge hook erases refs atomically", async () => {
    const store = freshStore(tmp);
    const storage = store.moduleStorage("bujo");
    const table = storage.tableName("collection_items");
    storage.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
         collection TEXT NOT NULL,
         entry_id INTEGER NOT NULL,
         position INTEGER NOT NULL,
         PRIMARY KEY (collection, entry_id)
       )`,
    );
    store.onEntryPurged((id) => {
      storage.prepare(`DELETE FROM ${table} WHERE entry_id = ?`).run(id);
    });

    const kept = await store.insert({ body: "kept entry" });
    const purged = await store.insert({ body: "purged entry" });
    const add = storage.prepare(
      `INSERT INTO ${table} (collection, entry_id, position) VALUES (?, ?, ?)`,
    );
    add.run("reading-list", kept.id, 1);
    add.run("reading-list", purged.id, 2);

    assert.equal(store.purgeEntry(purged.id), true);
    const rows = storage.prepare(`SELECT entry_id FROM ${table} ORDER BY position`).all() as Array<{
      entry_id: number;
    }>;
    assert.deepEqual(
      rows.map((r) => r.entry_id),
      [kept.id],
      "the purged entry's module row is gone; others survive",
    );
    store.close();
  });

  it("a throwing purge hook aborts the purge — entry and vector remain", async () => {
    const store = freshStore(tmp);
    const { id } = await store.insert({ body: "protected by a broken hook" });
    store.onEntryPurged(() => {
      throw new Error("module cleanup failed");
    });

    assert.throws(() => store.purgeEntry(id), /module cleanup failed/);
    assert.equal(store.getEntry(id)?.body, "protected by a broken hook");
    assert.equal(store.entryStats().vectors, 1, "nothing half-deleted");
    store.close();
  });
});
