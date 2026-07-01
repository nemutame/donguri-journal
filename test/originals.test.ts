/**
 * LocalDirStore: content-addressed save/dedup, MIME resolution + backfill,
 * traversal-proof get/delete, and stats. These guard the "server stores bytes
 * verbatim, never interprets them, never leaks paths for bad refs" contract.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { LocalDirStore } from "../src/originals/store.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

describe("LocalDirStore", () => {
  let tmp: TempDir;
  let store: LocalDirStore;
  before(() => {
    tmp = makeTempDir();
    store = new LocalDirStore(tmp.file("originals"));
  });
  after(() => {
    tmp.cleanup();
  });

  it("saves content-addressed and dedups identical bytes regardless of name", async () => {
    const data = Buffer.from("PNGDATA");
    const a = await store.save({ data, filename: "a.png" });
    const b = await store.save({ data, filename: "totally-different.bin" });
    assert.equal(a.ref, b.ref, "same bytes => same ref");
    assert.match(a.ref, /^local:[a-f0-9]{64}$/);
  });

  it("resolves MIME from extension and backfills a missing MIME later", async () => {
    const data = Buffer.from("image-bytes-xyz");
    const first = await store.save({ data, filename: "photo.jpg" });
    assert.equal(first.mime, "image/jpeg");
    // A later save with an explicit MIME must not lose the already-known one.
    const again = await store.save({ data, mime: "image/jpeg", filename: "photo.jpg" });
    assert.equal(again.mime, "image/jpeg");
  });

  it("round-trips bytes through get()", async () => {
    const data = Buffer.from("hello-original");
    const { ref } = await store.save({ data, mime: "text/plain" });
    const loaded = await store.get(ref);
    assert.ok(loaded);
    assert.deepEqual(loaded?.data, data);
    assert.equal(loaded?.mime, "text/plain");
    assert.equal(readFileSync(loaded?.path as string).toString(), "hello-original");
  });

  it("rejects malformed / traversal refs without touching disk", async () => {
    assert.equal(await store.get("local:../../etc/passwd"), null);
    assert.equal(await store.get("local:not-hex"), null);
    assert.equal(await store.get("other:whatever"), null);
    assert.equal(await store.get(`local:${"a".repeat(63)}`), null); // wrong length
  });

  it("deletes a blob + sidecar and reports stats", async () => {
    const solo = new LocalDirStore(tmp.file("solo"));
    const { ref } = await solo.save({ data: Buffer.from("to-be-removed"), mime: "text/plain" });
    let stats = await solo.stats();
    assert.equal(stats.count, 1);
    assert.ok(stats.bytes > 0);

    assert.equal(await solo.delete(ref), true);
    assert.equal(await solo.delete(ref), false, "already gone");
    stats = await solo.stats();
    assert.equal(stats.count, 0);
    assert.equal(stats.bytes, 0);
  });

  it("stats() on a never-created dir is zero, not an error", async () => {
    const empty = new LocalDirStore(tmp.file("never-made"));
    assert.deepEqual(await empty.stats(), { count: 0, bytes: 0 });
  });
});
