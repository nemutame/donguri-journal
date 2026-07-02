/**
 * Annotation vocabulary: reserved meta keys are validated when present, and
 * free-form keys pass through untouched (DESIGN §6).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { annotatedMetaSchema, linkRelSchema } from "../src/db/annotations.js";

describe("annotatedMetaSchema", () => {
  it("accepts a fully annotated meta and preserves free-form keys", () => {
    const parsed = annotatedMetaSchema.parse({
      nature: "action",
      status: "open",
      priority: true,
      due: "2026-07-05",
      delegated_to: "Tanaka",
      granularity: "month",
      mood: "cheerful",
      location: { lat: 35.68, lon: 139.76 },
    });
    assert.equal(parsed.nature, "action");
    assert.equal(parsed.mood, "cheerful");
    assert.deepEqual(parsed.location, { lat: 35.68, lon: 139.76 });
  });

  it("accepts an empty object (all reserved keys optional)", () => {
    assert.deepEqual(annotatedMetaSchema.parse({}), {});
  });

  it("rejects an unknown nature", () => {
    assert.equal(annotatedMetaSchema.safeParse({ nature: "bujo-task" }).success, false);
  });

  it("rejects an unknown status", () => {
    assert.equal(annotatedMetaSchema.safeParse({ status: "migrated" }).success, false);
  });

  it("rejects priority: false (marker is true-or-absent)", () => {
    assert.equal(annotatedMetaSchema.safeParse({ priority: false }).success, false);
  });

  it("rejects a due that is not a plain ISO date", () => {
    assert.equal(annotatedMetaSchema.safeParse({ due: "2026-07-05T09:00:00Z" }).success, false);
    assert.equal(annotatedMetaSchema.safeParse({ due: "next week" }).success, false);
  });

  it("rejects an unknown granularity", () => {
    assert.equal(annotatedMetaSchema.safeParse({ granularity: "week" }).success, false);
  });
});

describe("linkRelSchema", () => {
  it("accepts the initial vocabulary and rejects others", () => {
    assert.equal(linkRelSchema.safeParse("continues").success, true);
    assert.equal(linkRelSchema.safeParse("references").success, true);
    assert.equal(linkRelSchema.safeParse("blocks").success, false);
  });
});
