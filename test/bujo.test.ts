/**
 * BuJo lens: pure window math, and the projections that derive every glyph
 * from view-neutral data (nature/status/granularity + continues links) —
 * nothing BuJo-specific is ever read from storage.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JournalStore } from "../src/db/store.js";
import {
  DOCUMENT_MEDIUM_HINT,
  PROJECTION_FIDELITY_HINT,
  buildDayLog,
  buildFutureLog,
  buildMonthLog,
  buildReconcile,
  carryCount,
  dayWindowUtc,
  localYm,
  monthWindowUtc,
} from "../src/modules/bujo.js";
import { FakeEmbedder } from "./helpers/fake-embedder.js";
import { type TempDir, makeTempDir } from "./helpers/tmp.js";

const JST = 540; // +09:00

function freshStore(tmp: TempDir): JournalStore {
  const store = new JournalStore(
    tmp.file(`bujo-${Math.random().toString(36).slice(2)}.db`),
    new FakeEmbedder(),
  );
  store.init();
  return store;
}

type Items = Array<{ body: string; glyph: string }>;
function items(log: { structured: Record<string, unknown> }): Items {
  return (log.structured as { items: Items }).items;
}

describe("bujo windows", () => {
  it("dayWindowUtc shifts a local day into UTC", () => {
    const w = dayWindowUtc("2026-07-02", JST);
    assert.equal(w.since, "2026-07-01T15:00:00.000Z");
    assert.equal(w.until, "2026-07-02T14:59:59.999Z");
  });

  it("monthWindowUtc covers the local month inclusively", () => {
    const w = monthWindowUtc("2026-12", 0);
    assert.equal(w.since, "2026-12-01T00:00:00.000Z");
    assert.equal(w.until, "2026-12-31T23:59:59.999Z");
  });

  it("localYm respects the offset across a month boundary", () => {
    assert.equal(localYm("2026-06-30T16:00:00Z", JST), "2026-07");
    assert.equal(localYm("2026-06-30T16:00:00Z", 0), "2026-06");
  });
});

describe("bujo projections", () => {
  let tmp: TempDir;
  before(() => {
    tmp = makeTempDir();
  });
  after(() => {
    tmp.cleanup();
  });

  it("derives day-log glyphs from generic annotations", async () => {
    const store = freshStore(tmp);
    const day = "2026-07-02";
    const at = (h: number) => `${day}T${String(h).padStart(2, "0")}:00:00Z`;
    await store.insert({ body: "open task", occurred_at: at(9), meta: { nature: "action" } });
    await store.insert({
      body: "done task",
      occurred_at: at(10),
      meta: { nature: "action", status: "done" },
    });
    await store.insert({
      body: "dropped task",
      occurred_at: at(11),
      meta: { nature: "action", status: "dropped" },
    });
    await store.insert({ body: "dentist", occurred_at: at(14), meta: { nature: "event" } });
    await store.insert({ body: "a thought", occurred_at: at(15), meta: { nature: "note" } });
    await store.insert({ body: "untyped line", occurred_at: at(16) });
    await store.insert({
      body: "month-level task",
      occurred_at: `${day}T00:00:00Z`,
      meta: { nature: "action", granularity: "month" },
    });

    const got = items(buildDayLog(store, { date: day }));
    assert.deepEqual(
      got.map((i) => [i.glyph, i.body]),
      [
        ["•", "open task"],
        ["x", "done task"],
        ["~", "dropped task"],
        ["○", "dentist"],
        ["–", "a thought"],
        ["–", "untyped line"],
      ],
      "chronological order, month-granularity excluded",
    );
    store.close();
  });

  it("renders a carried task as > (day successor) and < (future-month successor)", async () => {
    const store = freshStore(tmp);
    const migrated = await store.insert({
      body: "write blog draft",
      occurred_at: "2026-07-01T09:00:00Z",
      meta: { nature: "action" },
    });
    await store.insert({
      body: "write blog draft, but better",
      occurred_at: "2026-07-02T09:00:00Z",
      meta: { nature: "action" },
      links: [{ rel: "continues", to: migrated.id }],
    });
    const scheduled = await store.insert({
      body: "plan the autumn trip",
      occurred_at: "2026-07-01T10:00:00Z",
      meta: { nature: "action" },
    });
    await store.insert({
      body: "plan the autumn trip",
      occurred_at: "2026-10-01T00:00:00Z",
      meta: { nature: "action", granularity: "month" },
      links: [{ rel: "continues", to: scheduled.id }],
    });

    const got = items(buildDayLog(store, { date: "2026-07-01" }));
    assert.deepEqual(
      got.map((i) => [i.glyph, i.body]),
      [
        [">", "write blog draft"],
        ["<", "plan the autumn trip"],
      ],
    );
    // The successor day shows the carried task as open, with its history depth.
    const day2 = items(buildDayLog(store, { date: "2026-07-02" }));
    assert.deepEqual(
      day2.map((i) => [i.glyph, i.body]),
      [["•", "write blog draft, but better"]],
    );
    store.close();
  });

  it("carryCount walks the continues chain", async () => {
    const store = freshStore(tmp);
    const first = await store.insert({
      body: "stubborn task",
      occurred_at: "2026-07-01T00:00:00Z",
      meta: { nature: "action" },
    });
    const second = await store.insert({
      body: "stubborn task again",
      occurred_at: "2026-07-02T00:00:00Z",
      meta: { nature: "action" },
      links: [{ rel: "continues", to: first.id }],
    });
    const third = await store.insert({
      body: "stubborn task, third time",
      occurred_at: "2026-07-03T00:00:00Z",
      meta: { nature: "action" },
      links: [{ rel: "continues", to: second.id }],
    });
    assert.equal(carryCount(store, first.id), 0);
    assert.equal(carryCount(store, third.id), 2);
    store.close();
  });

  it("buildMonthLog splits the spread: events on the calendar, month tasks on the task page", async () => {
    const store = freshStore(tmp);
    await store.insert({
      body: "team offsite",
      occurred_at: "2026-08-12T02:00:00Z",
      meta: { nature: "event" },
    });
    await store.insert({
      body: "renew passport",
      occurred_at: "2026-08-01T00:00:00Z",
      meta: { nature: "action", granularity: "month" },
    });
    await store.insert({
      body: "a daily task, not on the monthly spread",
      occurred_at: "2026-08-12T03:00:00Z",
      meta: { nature: "action" },
    });

    const { structured } = buildMonthLog(store, { month: "2026-08" });
    const calendar = structured.calendar as Array<{ date: string; items: Items }>;
    const tasks = structured.tasks as Items;
    assert.deepEqual(
      calendar.map((d) => [d.date, d.items.map((i) => i.body)]),
      [["2026-08-12", ["team offsite"]]],
    );
    assert.deepEqual(
      tasks.map((i) => [i.glyph, i.body]),
      [["•", "renew passport"]],
    );
    store.close();
  });

  it("buildFutureLog groups month-granularity entries per local month", async () => {
    const store = freshStore(tmp);
    await store.insert({
      body: "ski trip",
      occurred_at: "2027-01-01T00:00:00Z",
      meta: { nature: "event", granularity: "month" },
    });
    await store.insert({
      body: "tax filing",
      occurred_at: "2027-02-01T00:00:00Z",
      meta: { nature: "action", granularity: "month" },
    });
    const { structured } = buildFutureLog(store, { from_month: "2027-01", months: 3 });
    const groups = structured.groups as Array<{ month: string; items: Items }>;
    assert.deepEqual(
      groups.map((g) => [g.month, g.items.map((i) => i.body)]),
      [
        ["2027-01", ["ski trip"]],
        ["2027-02", ["tax filing"]],
      ],
    );
    store.close();
  });

  it("buildReconcile lists only open, un-carried actions from before the date", async () => {
    const store = freshStore(tmp);
    await store.insert({
      body: "old open action",
      occurred_at: "2026-06-28T09:00:00Z",
      meta: { nature: "action" },
    });
    const carried = await store.insert({
      body: "carried action",
      occurred_at: "2026-06-29T09:00:00Z",
      meta: { nature: "action" },
    });
    await store.insert({
      body: "carried action, take two",
      occurred_at: "2026-07-01T09:00:00Z",
      meta: { nature: "action" },
      links: [{ rel: "continues", to: carried.id }],
    });
    await store.insert({
      body: "finished action",
      occurred_at: "2026-06-30T09:00:00Z",
      meta: { nature: "action", status: "done" },
    });
    await store.insert({
      body: "future month action",
      occurred_at: "2026-09-01T00:00:00Z",
      meta: { nature: "action", granularity: "month" },
    });
    await store.insert({ body: "just a note", occurred_at: "2026-06-28T10:00:00Z" });

    const { structured } = buildReconcile(store, { before_date: "2026-07-02" });
    const open = structured.open_actions as Array<{ body: string; age_days: number }>;
    assert.deepEqual(
      open.map((o) => o.body),
      ["old open action", "carried action, take two"],
      "oldest first; carried/done/future/non-action excluded, successor included",
    );
    // Local calendar-day difference: logged on 06-28, reviewed on 07-02.
    assert.equal(open[0]?.age_days, 4);
    store.close();
  });

  it("buildDayLog respects the tz offset across the UTC date boundary", async () => {
    const store = freshStore(tmp);
    // 16:00Z on 07-01 is already 01:00 on 07-02 in JST (+09:00).
    await store.insert({
      body: "late-night thought",
      occurred_at: "2026-07-01T16:00:00Z",
      meta: { nature: "note" },
    });
    const jstDay2 = items(buildDayLog(store, { date: "2026-07-02", tz_offset_minutes: JST }));
    assert.deepEqual(
      jstDay2.map((i) => i.body),
      ["late-night thought"],
    );
    assert.equal(
      items(buildDayLog(store, { date: "2026-07-01", tz_offset_minutes: JST })).length,
      0,
    );
    // In UTC the same entry belongs to 07-01.
    assert.equal(items(buildDayLog(store, { date: "2026-07-01" })).length, 1);
    store.close();
  });

  it("buildMonthLog places a UTC month-boundary event in the local month", async () => {
    const store = freshStore(tmp);
    // 20:00Z on 06-30 is 05:00 on 07-01 in JST.
    await store.insert({
      body: "midnight launch",
      occurred_at: "2026-06-30T20:00:00Z",
      meta: { nature: "event" },
    });
    const { structured } = buildMonthLog(store, { month: "2026-07", tz_offset_minutes: JST });
    const calendar = structured.calendar as Array<{ date: string; items: Items }>;
    assert.deepEqual(
      calendar.map((d) => [d.date, d.items.map((i) => i.body)]),
      [["2026-07-01", ["midnight launch"]]],
    );
    const june = buildMonthLog(store, { month: "2026-06", tz_offset_minutes: JST });
    assert.equal((june.structured.calendar as unknown[]).length, 0);
    store.close();
  });

  it("a soft-deleted successor makes the action open again for reconcile", async () => {
    const store = freshStore(tmp);
    const old = await store.insert({
      body: "haunted task",
      occurred_at: "2026-06-01T00:00:00Z",
      meta: { nature: "action" },
    });
    const successor = await store.insert({
      body: "haunted task v2",
      occurred_at: "2026-06-02T00:00:00Z",
      meta: { nature: "action" },
      links: [{ rel: "continues", to: old.id }],
    });
    assert.equal(store.openActions({ before: "2026-07-01T00:00:00Z" }).length, 1);
    store.softDelete(successor.id);
    assert.deepEqual(
      store.openActions({ before: "2026-07-01T00:00:00Z" }).map((e) => e.body),
      ["haunted task"],
    );
    store.close();
  });
});

describe("document medium hints", () => {
  let tmp: TempDir;
  before(() => {
    tmp = makeTempDir();
  });
  after(() => {
    tmp.cleanup();
  });

  it("log-shaped views tell the agent to render a persistent document", () => {
    const store = freshStore(tmp);
    const day = buildDayLog(store, { date: "2026-07-02" });
    const month = buildMonthLog(store, { month: "2026-07" });
    const future = buildFutureLog(store, { from_month: "2026-08" });
    for (const view of [day, month, future]) {
      assert.equal(view.presentation_hints.medium, DOCUMENT_MEDIUM_HINT);
      assert.equal(view.presentation_hints.fidelity, PROJECTION_FIDELITY_HINT);
    }
    // Reconcile is the interactive ritual — it belongs in the conversation.
    const reconcile = buildReconcile(store, { before_date: "2026-07-02" });
    assert.equal(reconcile.presentation_hints.medium, undefined);
    store.close();
  });
});
