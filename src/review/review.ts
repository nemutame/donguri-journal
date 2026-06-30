/**
 * generate_review — pull entries in a time window and return rich aggregates:
 * structured data + a rendered PNG activity chart + presentation hints, so the
 * front-end LLM can present a reflective review (not just a markdown list).
 */
import {
  type DayCount,
  type JournalStore,
  type ReviewTimeWindow,
  type SourceKindCount,
  type TagCount,
  normalizeTimestamp,
} from "../db/store.js";
import { barChartSvg, renderPng } from "./charts.js";
import { type ReviewPeriod, type ReviewWindow, computeWindow } from "./window.js";

export interface GenerateReviewInput {
  period?: ReviewPeriod;
  anchor?: string;
  since?: string;
  until?: string;
  time_field?: "created_at" | "occurred_at";
}

export interface ReviewStructured {
  window: ReviewWindow;
  time_field: "created_at" | "occurred_at";
  total: number;
  busiest_day: DayCount | null;
  by_day: DayCount[];
  by_source_kind: SourceKindCount[];
  top_tags: TagCount[];
}

export interface ReviewOutput {
  structured: ReviewStructured;
  /** PNG chart of entries per day, if rendering succeeded. */
  chartPng: Buffer | null;
  presentation_hints: Record<string, unknown>;
}

export async function generateReview(
  store: JournalStore,
  input: GenerateReviewInput,
): Promise<ReviewOutput> {
  const timeField = input.time_field === "occurred_at" ? "occurred_at" : "created_at";

  // A custom window needs both bounds; one-sided input must fail loudly rather
  // than silently falling back to `period` and returning a different range.
  const { since, until } = input;
  if ((since === undefined) !== (until === undefined)) {
    throw new Error(
      "A custom window requires both `since` and `until` (or neither — use `period`).",
    );
  }

  let window: ReviewWindow;
  if (since !== undefined && until !== undefined) {
    const s = normalizeTimestamp(since);
    const u = normalizeTimestamp(until);
    if (s > u) {
      throw new Error(`Invalid custom window: since (${s}) is after until (${u}).`);
    }
    window = { since: s, until: u, label: `${s}–${u} (custom)` };
  } else {
    window = computeWindow(input.period ?? "week", input.anchor);
  }

  const filter: ReviewTimeWindow = {
    since: window.since,
    until: window.until,
    time_field: timeField,
  };

  const byDay = store.aggregateByDay(filter);
  const total = store.countInWindow(filter);
  const bySourceKind = store.aggregateBySourceKind(filter);
  const topTags = store.aggregateTags(filter, 10);
  const busiestDay = byDay.reduce<DayCount | null>(
    (best, d) => (best === null || d.count > best.count ? d : best),
    null,
  );

  const structured: ReviewStructured = {
    window,
    time_field: timeField,
    total,
    busiest_day: busiestDay,
    by_day: byDay,
    by_source_kind: bySourceKind,
    top_tags: topTags,
  };

  let chartPng: Buffer | null = null;
  if (byDay.length > 0) {
    try {
      const svg = barChartSvg(
        `Entries per day — ${window.label}`,
        byDay.map((d) => ({ label: d.day.slice(5), value: d.count })),
      );
      chartPng = await renderPng(svg);
    } catch {
      chartPng = null;
    }
  }

  const presentation_hints: Record<string, unknown> = {
    headline: `Review of ${window.label}: ${total} ${total === 1 ? "entry" : "entries"}`,
    highlight: {
      total,
      busiest_day: busiestDay,
      top_tags: topTags.slice(0, 5),
    },
    chart: chartPng
      ? "A PNG bar chart of entries per day is attached; show it alongside your summary."
      : "No chart was rendered (no entries in window, or rendering unavailable).",
    tone: "Reflective and concise. Surface notable themes; invite the user to reflect.",
    suggestions: [
      total === 0
        ? "Window is empty — gently note it and suggest capturing more."
        : "Call out the busiest day and the recurring tags.",
      "If patterns recur, consider calling surface_patterns for deeper echoes.",
    ],
  };

  return { structured, chartPng, presentation_hints };
}
