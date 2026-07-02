/**
 * hardDeleteEntry error paths and the erase-claim guard: every failure leaves
 * the operation retryable, and a ref being erased can't be re-attached out
 * from under the orphan check.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { hardDeleteEntry } from "../src/db/deletion.js";
import { JournalStore } from "../src/db/store.js";
import type { OriginalStore } from "../src/originals/store.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

const REF = `local:${"a".repeat(64)}`;

function failingOriginals(overrides: Partial<OriginalStore> = {}): OriginalStore {
  return {
    kind: "failing",
    save: () => Promise.reject(new Error("not under test")),
    get: () => Promise.resolve(null),
    delete: () => Promise.reject(new Error("disk on fire")),
    stats: () => Promise.resolve({ count: 0, bytes: 0 }),
    ...overrides,
  };
}

describe("hardDeleteEntry failure paths", () => {
  let tmp: TempDir;
  before(() => {
    tmp = makeTempDir();
  });
  after(() => {
    tmp.cleanup();
  });

  function freshStore(): JournalStore {
    const store = new JournalStore(
      tmp.file(`del-${Math.random().toString(36).slice(2)}.db`),
      new FakeEmbedder(),
    );
    store.init();
    return store;
  }

  it("original-erase failure leaves the entry intact and retryable", async () => {
    const store = freshStore();
    const entry = await store.insert({ body: "secret", original_ref: REF });
    const outcome = await hardDeleteEntry(store, failingOriginals(), () => {}, entry.id);
    assert.equal(outcome.ok, false);
    assert.match(!outcome.ok ? outcome.message : "", /retry/);
    assert.ok(store.getEntry(entry.id), "entry survives a failed erase");
    store.close();
  });

  it("purge failure after a successful erase reports the finish-it message", async () => {
    const store = freshStore();
    const entry = await store.insert({ body: "doomed", original_ref: REF });
    // A purge hook that throws aborts the purge transaction — the documented
    // module-cleanup failure mode.
    store.onEntryPurged(() => {
      throw new Error("module cleanup exploded");
    });
    const okOriginals = failingOriginals({ delete: () => Promise.resolve(true) });
    const outcome = await hardDeleteEntry(store, okOriginals, () => {}, entry.id);
    assert.equal(outcome.ok, false);
    assert.match(!outcome.ok ? outcome.message : "", /run delete again/);
    assert.ok(store.getEntry(entry.id), "entry survives the aborted purge");
    store.close();
  });

  it("a claimed ref refuses new attachments until released", async () => {
    const store = freshStore();
    const bare = await store.insert({ body: "no original yet" });
    store.claimOriginalErase(REF);
    assert.equal(store.attachOriginalIfAbsent(bare.id, REF), false);
    await assert.rejects(
      store.insert({ body: "capture during erase", original_ref: REF }),
      /being erased/,
    );
    store.releaseOriginalErase(REF);
    assert.equal(store.attachOriginalIfAbsent(bare.id, REF), true);
    store.close();
  });

  it("erase failure releases the claim (no permanently poisoned ref)", async () => {
    const store = freshStore();
    const entry = await store.insert({ body: "secret", original_ref: REF });
    await hardDeleteEntry(store, failingOriginals(), () => {}, entry.id);
    // The finally released the claim: a fresh capture may reference the ref.
    const again = await store.insert({ body: "recaptured", original_ref: REF });
    assert.ok(store.getEntry(again.id));
    store.close();
  });
});
