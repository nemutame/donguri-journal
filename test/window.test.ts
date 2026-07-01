/**
 * computeWindow: UTC calendar boundaries for reviews. Inclusive ends are 1 ms
 * before the next window start, so they line up with lexicographic comparison of
 * the stored `...Z` timestamps.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeWindow } from "../src/review/window.js";

describe("computeWindow", () => {
  it("day: the full UTC calendar day around the anchor", () => {
    const w = computeWindow("day", "2026-06-15T13:45:00Z");
    assert.equal(w.since, "2026-06-15T00:00:00.000Z");
    assert.equal(w.until, "2026-06-15T23:59:59.999Z");
    assert.equal(w.label, "2026-06-15 (day)");
  });

  it("week: Monday 00:00 through Sunday 23:59:59.999 (UTC)", () => {
    // 2026-06-15 is a Monday.
    const w = computeWindow("week", "2026-06-17T09:00:00Z");
    assert.equal(w.since, "2026-06-15T00:00:00.000Z");
    assert.equal(w.until, "2026-06-21T23:59:59.999Z");
    assert.match(w.label, /^2026-06-15–2026-06-21 \(week\)$/);
  });

  it("month: first through last instant of the calendar month", () => {
    const w = computeWindow("month", "2026-02-10T00:00:00Z");
    assert.equal(w.since, "2026-02-01T00:00:00.000Z");
    assert.equal(w.until, "2026-02-28T23:59:59.999Z"); // 2026 is not a leap year
    assert.equal(w.label, "2026-02 (month)");
  });

  it("rejects an invalid anchor", () => {
    assert.throws(() => computeWindow("day", "nonsense"), /Invalid anchor/);
  });
});
