/**
 * Calendar window helpers for reviews. All windows are computed in UTC so they
 * line up with the stored `...Z` timestamps (see normalizeTimestamp in store).
 */

export type ReviewPeriod = "day" | "week" | "month";

export interface ReviewWindow {
  /** Inclusive ISO-8601 lower bound. */
  since: string;
  /** Inclusive ISO-8601 upper bound. */
  until: string;
  /** Human-readable label, e.g. "2026-06 (month)". */
  label: string;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** End of an inclusive window: 1 ms before the start of the next window. */
function inclusiveEnd(exclusiveStartOfNext: Date): string {
  return new Date(exclusiveStartOfNext.getTime() - 1).toISOString();
}

function dayLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the calendar window (day / ISO-week Mon–Sun / month) containing
 * `anchorIso` (defaults to now).
 */
export function computeWindow(period: ReviewPeriod, anchorIso?: string): ReviewWindow {
  const anchor = anchorIso ? new Date(anchorIso) : new Date();
  if (Number.isNaN(anchor.getTime())) {
    throw new Error(`Invalid anchor timestamp: ${anchorIso}`);
  }

  if (period === "day") {
    const start = startOfDayUTC(anchor);
    const next = new Date(start);
    next.setUTCDate(start.getUTCDate() + 1);
    return {
      since: start.toISOString(),
      until: inclusiveEnd(next),
      label: `${dayLabel(start)} (day)`,
    };
  }

  if (period === "week") {
    const start = startOfDayUTC(anchor);
    // Shift back to Monday (getUTCDay: 0=Sun..6=Sat -> 0=Mon..6=Sun).
    const mondayOffset = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    const next = new Date(start);
    next.setUTCDate(start.getUTCDate() + 7);
    const sunday = new Date(next.getTime() - 1);
    return {
      since: start.toISOString(),
      until: inclusiveEnd(next),
      label: `${dayLabel(start)}–${dayLabel(sunday)} (week)`,
    };
  }

  // month
  const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const next = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  return {
    since: start.toISOString(),
    until: inclusiveEnd(next),
    label: `${start.toISOString().slice(0, 7)} (month)`,
  };
}
