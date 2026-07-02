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

  it("insert with links creates the relations (new → old)", async () => {
    const store = freshStore(tmp);
    const old = await store.insert({ body: "write blog draft", meta: { nature: "action" } });
    const carried = await store.insert({
      body: "write blog draft (day 2)",
      links: [{ rel: "continues", to: old.id }],
    });

    const fromNew = store.getLinks(carried.id);
    assert.deepEqual(
      fromNew.outgoing.map((l) => [l.rel, l.to_id]),
      [["continues", old.id]],
    );
    const atOld = store.getLinks(old.id);
    assert.deepEqual(
      atOld.incoming.map((l) => [l.rel, l.from_id]),
      [["continues", carried.id]],
    );
    store.close();
  });

  it("rejects a link to a missing target and captures nothing", async () => {
    const store = freshStore(tmp);
    const before = store.entryStats().active;
    await assert.rejects(
      store.insert({ body: "dangling", links: [{ rel: "references", to: 99999 }] }),
      /does not exist/,
    );
    assert.equal(store.entryStats().active, before, "aborted capture must not leave an entry");
    assert.equal(store.entryStats().vectors, before, "nor a vector");
    store.close();
  });

  it("rejects self-links and links to soft-deleted targets", async () => {
    const store = freshStore(tmp);
    const a = await store.insert({ body: "link base A" });
    const b = await store.insert({ body: "link base B" });
    assert.throws(() => store.addLink(a.id, "references", a.id), /cannot link to itself/);
    store.softDelete(b.id);
    assert.throws(() => store.addLink(a.id, "references", b.id), /does not exist/);
    store.close();
  });

  it("addLink is idempotent and a deduped capture still attaches links", async () => {
    const store = freshStore(tmp);
    const old = await store.insert({ body: "old task", occurred_at: "2026-01-01T00:00:00Z" });
    const a = await store.insert({ body: "new task", occurred_at: "2026-01-02T00:00:00Z" });

    assert.equal(store.addLink(a.id, "references", old.id), true);
    assert.equal(store.addLink(a.id, "references", old.id), false, "re-add is a no-op");

    // Identical re-capture (dedup) carrying a new link must still attach it.
    const again = await store.insert({
      body: "new task",
      occurred_at: "2026-01-02T00:00:00Z",
      links: [{ rel: "continues", to: old.id }],
    });
    assert.equal(again.deduped, true);
    assert.deepEqual(
      store
        .getLinks(a.id)
        .outgoing.map((l) => l.rel)
        .sort(),
      ["continues", "references"],
    );
    store.close();
  });

  it("updateAnnotations merges reserved keys and preserves free-form meta", async () => {
    const store = freshStore(tmp);
    const { id } = await store.insert({
      body: "annotate me",
      meta: { nature: "action", status: "open", mood: "focused" },
    });

    const meta = store.updateAnnotations(id, { status: "done", delegated_to: "Tanaka" });
    assert.ok(meta);
    assert.equal(meta.status, "done");
    assert.equal(meta.delegated_to, "Tanaka");
    assert.equal(meta.nature, "action", "untouched reserved key survives");
    assert.equal(meta.mood, "focused", "free-form key survives");

    // The persisted row reflects the merge; body/vector untouched.
    const [row] = store.query({ tag: undefined, limit: 500 }).filter((e) => e.id === id);
    assert.equal(row?.meta.status, "done");
    assert.equal(store.entryStats().vectors, store.entryStats().active);
    store.close();
  });

  it("updateAnnotations clears a key when the patch value is null", async () => {
    const store = freshStore(tmp);
    const { id } = await store.insert({
      body: "clear me",
      meta: { nature: "action", priority: true, due: "2026-07-10" },
    });
    const meta = store.updateAnnotations(id, { priority: null, due: null });
    assert.ok(meta);
    assert.ok(!("priority" in meta), "cleared key is removed, not stored as null");
    assert.ok(!("due" in meta));
    assert.equal(meta.nature, "action");
    store.close();
  });

  it("updateAnnotations returns null for missing or soft-deleted entries", async () => {
    const store = freshStore(tmp);
    assert.equal(store.updateAnnotations(99999, { status: "done" }), null);
    const { id } = await store.insert({ body: "soon deleted" });
    store.softDelete(id);
    assert.equal(store.updateAnnotations(id, { status: "done" }), null);
    store.close();
  });

  it("hard delete purges links in both directions", async () => {
    const store = freshStore(tmp);
    const a = await store.insert({ body: "purge links A" });
    const b = await store.insert({
      body: "purge links B",
      links: [{ rel: "continues", to: a.id }],
    });
    const c = await store.insert({
      body: "purge links C",
      links: [{ rel: "references", to: b.id }],
    });

    assert.equal(store.purgeEntry(b.id), true);
    assert.equal(store.getLinks(a.id).incoming.length, 0, "incoming side gone");
    assert.equal(store.getLinks(c.id).outgoing.length, 0, "outgoing side gone");
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
