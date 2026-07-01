/**
 * JournalStore: the invariants that were hard-won during Phase 1 implementation
 * and are painful if they regress — vec0 BigInt rowid + Float32 blob, content
 * dedup, soft/hard delete semantics, the KNN recall path, and reindex.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JournalStore, normalizeTimestamp } from "../src/db/store.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

function freshStore(tmp: TempDir, embedder = new FakeEmbedder()): JournalStore {
  const store = new JournalStore(
    tmp.file(`journal-${Math.random().toString(36).slice(2)}.db`),
    embedder,
  );
  store.init();
  return store;
}

describe("normalizeTimestamp", () => {
  it("canonicalizes any offset to UTC Z", () => {
    assert.equal(normalizeTimestamp("2026-01-02T12:00:00+09:00"), "2026-01-02T03:00:00.000Z");
    assert.equal(normalizeTimestamp("2026-01-02T03:00:00Z"), "2026-01-02T03:00:00.000Z");
  });

  it("rejects invalid input", () => {
    assert.throws(() => normalizeTimestamp("not-a-date"), /Invalid ISO-8601/);
  });
});

describe("JournalStore", () => {
  let tmp: TempDir;
  before(() => {
    tmp = makeTempDir();
  });
  after(() => {
    tmp.cleanup();
  });

  it("inserts and reports a real integer id + a vector row", async () => {
    const store = freshStore(tmp);
    const { id, deduped } = await store.insert({ body: "hello acorns" });
    assert.equal(deduped, false);
    assert.ok(Number.isInteger(id) && id > 0);
    assert.equal(store.entryStats().vectors, 1);
    store.close();
  });

  it("deduplicates identical body+occurred_at without a second vector", async () => {
    const store = freshStore(tmp);
    const first = await store.insert({ body: "same thought", occurred_at: "2026-01-01T00:00:00Z" });
    const second = await store.insert({
      body: "same thought",
      occurred_at: "2026-01-01T00:00:00Z",
    });
    assert.equal(second.deduped, true);
    assert.equal(second.id, first.id);
    assert.equal(store.entryStats().active, 1);
    assert.equal(store.entryStats().vectors, 1);
    store.close();
  });

  it("filters by since/until/tag/source_kind in query()", async () => {
    const store = freshStore(tmp);
    await store.insert({
      body: "jan",
      occurred_at: "2026-01-15T00:00:00Z",
      tags: ["a"],
      source_kind: "note",
    });
    await store.insert({
      body: "feb",
      occurred_at: "2026-02-15T00:00:00Z",
      tags: ["b"],
      source_kind: "note",
    });
    await store.insert({
      body: "mar",
      occurred_at: "2026-03-15T00:00:00Z",
      tags: ["a"],
      source_kind: "image",
    });

    const byWindow = store.query({
      time_field: "occurred_at",
      since: "2026-02-01T00:00:00Z",
      until: "2026-02-28T00:00:00Z",
    });
    assert.deepEqual(
      byWindow.map((e) => e.body),
      ["feb"],
    );

    const byTag = store.query({ tag: "a", time_field: "occurred_at" });
    assert.deepEqual(byTag.map((e) => e.body).sort(), ["jan", "mar"]);

    const byKind = store.query({ source_kind: "image" });
    assert.deepEqual(
      byKind.map((e) => e.body),
      ["mar"],
    );
    store.close();
  });

  it("recalls the nearest entry by meaning via the KNN path", async () => {
    const store = freshStore(tmp);
    await store.insert({ body: "the cat sat on the mat" });
    await store.insert({ body: "quantum chromodynamics lecture notes" });
    const hits = await store.recall("a cat on a mat", 1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.body, "the cat sat on the mat");
    assert.equal(typeof hits[0]?.distance, "number");
    store.close();
  });

  it("soft delete hides from query/recall and re-capture restores it", async () => {
    const store = freshStore(tmp);
    const { id } = await store.insert({ body: "delible", occurred_at: "2026-01-01T00:00:00Z" });

    assert.equal(store.softDelete(id), true);
    assert.equal(store.query({}).length, 0);
    assert.equal((await store.recall("delible", 5)).length, 0);
    assert.equal(store.entryStats().soft_deleted, 1);
    // Vector is retained even while tombstoned.
    assert.equal(store.entryStats().vectors, 1);

    const again = await store.insert({ body: "delible", occurred_at: "2026-01-01T00:00:00Z" });
    assert.equal(again.deduped, true);
    assert.equal(again.id, id);
    assert.equal(store.query({}).length, 1);
    store.close();
  });

  it("hard delete purges the row + vector and flags an orphaned original", async () => {
    const store = freshStore(tmp);
    const { id } = await store.insert({ body: "purge me", original_ref: "local:deadbeef" });

    const peek = store.peekHardDelete(id);
    assert.equal(peek.exists, true);
    assert.equal(peek.original_ref, "local:deadbeef");
    assert.equal(peek.orphan, true, "sole referrer => orphan");

    assert.equal(store.purgeEntry(id), true);
    assert.equal(store.query({ include_deleted: true }).length, 0);
    assert.equal(store.entryStats().vectors, 0);
    assert.equal(store.peekHardDelete(id).exists, false);
    store.close();
  });

  it("does not flag an original still referenced by another entry", async () => {
    const store = freshStore(tmp);
    const a = await store.insert({ body: "shared A", original_ref: "local:cafe" });
    await store.insert({ body: "shared B", original_ref: "local:cafe" });
    assert.equal(store.peekHardDelete(a.id).orphan, false);
    store.close();
  });

  it("reindex rebuilds every vector and keeps recall working", async () => {
    const store = freshStore(tmp);
    await store.insert({ body: "alpha beta" });
    await store.insert({ body: "gamma delta" });
    const result = await store.reindex();
    assert.equal(result.reindexed, 2);
    assert.equal(store.entryStats().vectors, 2);
    const hits = await store.recall("alpha beta", 1);
    assert.equal(hits[0]?.body, "alpha beta");
    store.close();
  });
});
