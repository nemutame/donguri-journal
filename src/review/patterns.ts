/**
 * surface_patterns — find recurring themes ("you wrote something similar
 * before"). For each recent entry we look for semantically similar OLDER
 * entries; clusters of echoes are returned as structured data + a PNG chart of
 * the strongest echoes + presentation hints. The front-end LLM judges which
 * echoes are meaningful and weaves the narrative.
 */
import type { Entry, JournalStore, RecallHit } from "../db/store.js";
import { barChartSvg, renderPng } from "./charts.js";

export interface SurfacePatternsInput {
  /** How far back to treat entries as "recent". Default 30 days. */
  lookback_days?: number;
  /** Max recent entries to examine. Default 50. */
  max_recent?: number;
  /** Neighbours to consider per recent entry. Default 5. */
  per_entry?: number;
  /** Distance cutoff; only echoes at or below this are kept. Default 1.3. */
  max_distance?: number;
}

export interface Echo {
  recent: Pick<Entry, "id" | "body" | "created_at" | "occurred_at" | "tags">;
  related: Array<Pick<RecallHit, "id" | "body" | "created_at" | "distance">>;
}

export interface PatternsOutput {
  structured: {
    lookback_days: number;
    max_distance: number;
    examined: number;
    echoes: Echo[];
  };
  chartPng: Buffer | null;
  presentation_hints: Record<string, unknown>;
}

function shortLabel(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 18 ? `${oneLine.slice(0, 17)}…` : oneLine;
}

export async function surfacePatterns(
  store: JournalStore,
  input: SurfacePatternsInput,
): Promise<PatternsOutput> {
  const lookbackDays = Math.min(Math.max(Math.trunc(input.lookback_days ?? 30), 1), 3650);
  const maxRecent = Math.min(Math.max(Math.trunc(input.max_recent ?? 50), 1), 200);
  const perEntry = Math.min(Math.max(Math.trunc(input.per_entry ?? 5), 1), 20);
  const maxDistance = input.max_distance ?? 1.3;

  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const recent = store.query({ since, time_field: "created_at", limit: maxRecent });

  const echoes: Echo[] = [];
  for (const entry of recent) {
    // Over-fetch: self and newer entries can crowd the top neighbours, so we
    // need a larger candidate pool to still find `perEntry` OLDER echoes.
    const candidateK = Math.min(100, perEntry * 4 + 5);
    const neighbours = await store.recall(entry.body, candidateK);
    const related = neighbours
      .filter(
        (h) => h.id !== entry.id && h.created_at < entry.created_at && h.distance <= maxDistance,
      )
      .slice(0, perEntry)
      .map((h) => ({ id: h.id, body: h.body, created_at: h.created_at, distance: h.distance }));
    if (related.length > 0) {
      echoes.push({
        recent: {
          id: entry.id,
          body: entry.body,
          created_at: entry.created_at,
          occurred_at: entry.occurred_at,
          tags: entry.tags,
        },
        related,
      });
    }
  }

  echoes.sort((a, b) => b.related.length - a.related.length);

  let chartPng: Buffer | null = null;
  if (echoes.length > 0) {
    try {
      const svg = barChartSvg(
        "Recurring echoes (recent entries with past matches)",
        echoes
          .slice(0, 12)
          .map((e) => ({ label: shortLabel(e.recent.body), value: e.related.length })),
      );
      chartPng = await renderPng(svg);
    } catch {
      chartPng = null;
    }
  }

  const presentation_hints: Record<string, unknown> = {
    headline:
      echoes.length > 0
        ? `Found ${echoes.length} recent ${echoes.length === 1 ? "entry that echoes" : "entries that echo"} earlier ones`
        : "No clear recurring themes in this window",
    interpretation:
      "Each echo is a candidate recurrence, not a certainty — judge relevance yourself before " +
      "presenting. Distances are L2 (smaller = closer); ~<1.2 is usually a strong match.",
    tone: "Curious and gentle: 'you've returned to this before…'. Avoid over-claiming.",
    chart: chartPng
      ? "A PNG chart of the strongest echoes is attached."
      : "No chart rendered (no echoes, or rendering unavailable).",
    next: "Use query_entries or recall_related to pull full context for any echo worth discussing.",
  };

  return {
    structured: {
      lookback_days: lookbackDays,
      max_distance: maxDistance,
      examined: recent.length,
      echoes,
    },
    chartPng,
    presentation_hints,
  };
}
